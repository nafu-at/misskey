/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import * as OTPAuth from 'otpauth';
import * as QRCode from 'qrcode';
import { DataSource, type EntityManager } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { MiAccessToken, MiAuthSession, MiUser, MiUserProfile, MiUserSecurityKey } from '@/models/_.js';
import { generateNativeUserToken } from '@/misc/token.js';
import { GlobalEventService } from './GlobalEventService.js';
import { RoleService } from './RoleService.js';
import { UserAuthService } from './UserAuthService.js';
import type { entities } from 'misskey-js';
import type { Redis } from 'ioredis';

export function tokenFingerprint(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

// Covers the longest-lived credential issued before credential binding was introduced (a two-week SSO JWT).
export const legacyCredentialRotationKey = (userId: string) => `auth:credentials-rotated:${userId}`;

export async function totpRegistrationData(secret: OTPAuth.Secret, username: string, issuer: string) {
	const url = new OTPAuth.TOTP({ secret, digits: 6, label: username, issuer }).toString();
	return { qr: await QRCode.toDataURL(url), url, secret: secret.base32, label: username, issuer };
}

export function generateBackupCodes(): string[] {
	return Array.from({ length: 20 }, () => new OTPAuth.Secret().base32);
}

@Injectable()
export class TwoFactorEnrollmentService {
	constructor(
		@Inject(DI.config) private config: Config,
		@Inject(DI.redis) private redis: Redis,
		@Inject(DI.db) private db: DataSource,
		private roleService: RoleService,
		private userAuthService: UserAuthService,
		private globalEventService: GlobalEventService,
	) {}

	public async begin(user: MiUser, passwordHash: string | null): Promise<entities.TwoFactorEnrollment | null> {
		// The caller has just verified a password or created an unenrolled account.
		if (user.host !== null || !(await this.roleService.getUserPolicies(user.id)).required2fa) return null;
		const secret = new OTPAuth.Secret();
		const ticket = randomBytes(32).toString('hex');
		const key = `2fa:enroll:${tokenFingerprint(ticket)}`;
		await this.redis.multi()
			.hset(key, { userId: user.id, credential: tokenFingerprint(JSON.stringify([user.token, passwordHash])), secret: secret.base32, attempts: 5 })
			.expire(key, 300).exec();
		const { qr, url, label } = await totpRegistrationData(secret, user.username, this.config.host);
		return { finished: false, next: 'enroll-2fa', ticket, qr, url, label };
	}

	public async complete(ticket: string, code: string) {
		const key = `2fa:enroll:${tokenFingerprint(ticket)}`;
		// Only decrement a live ticket, keeping its original expiration.
		const fields = await this.redis.eval(`
			if redis.call('exists', KEYS[1]) == 0 then return nil end
			local remaining = redis.call('hincrby', KEYS[1], 'attempts', -1)
			if remaining < 0 then return nil end
			return redis.call('hmget', KEYS[1], 'userId', 'credential', 'secret')
		`, 1, key) as [string, string, string] | null;
		if (!fields) return null;
		const [userId, credential, secret] = fields;
		const valid = await this.userAuthService.validateOtp(userId, secret, code);
		if (!valid || !await this.redis.del(key)) return null;

		if (!(await this.roleService.getUserPolicies(userId)).required2fa) return null;
		const result = await this.db.transaction(async manager => {
			const user = await manager.findOne(MiUser, { where: { id: userId }, lock: { mode: 'pessimistic_write' } });
			if (!user?.token || user.isSuspended || user.isDeleted || user.host !== null) return null;
			const profile = await manager.findOneOrFail(MiUserProfile, { where: { userId }, lock: { mode: 'pessimistic_write' } });
			if (profile.twoFactorEnabled || tokenFingerprint(JSON.stringify([user.token, profile.password])) !== credential) return null;
			const backupCodes = generateBackupCodes();
			await manager.update(MiUserProfile, { userId }, {
				twoFactorSecret: secret, twoFactorTempSecret: null, twoFactorBackupSecret: backupCodes, twoFactorEnabled: true,
			});
			const rotation = await this.rotateCredentials(manager, userId, user.token);
			user.token = rotation.newToken;
			return { user, rotation, backupCodes };
		});
		if (!result) return null;
		this.globalEventService.publishInternalEvent('userTokenRegenerated', result.rotation);
		return { user: result.user, backupCodes: result.backupCodes };
	}

	public async reset(userId: string) {
		const { required2fa } = await this.roleService.getUserPolicies(userId);
		const rotation = await this.db.transaction(async manager => {
			const user = await manager.findOneOrFail(MiUser, { where: { id: userId }, lock: { mode: 'pessimistic_write' } });
			await manager.delete(MiUserSecurityKey, { userId });
			await manager.update(MiUserProfile, { userId }, {
				twoFactorSecret: null, twoFactorTempSecret: null, twoFactorBackupSecret: null,
				twoFactorEnabled: false, usePasswordLessLogin: false, securityKeysAvailable: false,
			});
			if (!user.token || !required2fa) return null;
			return this.rotateCredentials(manager, userId, user.token);
		});
		if (rotation) this.globalEventService.publishInternalEvent('userTokenRegenerated', rotation);
	}

	private async rotateCredentials(manager: EntityManager, userId: string, oldToken: string) {
		const newToken = generateNativeUserToken();
		await manager.update(MiUser, userId, { token: newToken });
		await manager.delete(MiAccessToken, { userId });
		await manager.delete(MiAuthSession, { userId });
		await this.redis.set(legacyCredentialRotationKey(userId), '1', 'EX', 14 * 24 * 60 * 60);
		return { id: userId, oldToken, newToken };
	}
}
