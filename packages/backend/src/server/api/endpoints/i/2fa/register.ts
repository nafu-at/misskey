/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import bcrypt from 'bcryptjs';
import * as OTPAuth from 'otpauth';
import { Inject, Injectable } from '@nestjs/common';
import { IsNull } from 'typeorm';
import { totpRegistrationData } from '@/core/TwoFactorEnrollmentService.js';
import type { UserProfilesRepository } from '@/models/_.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { ApiError } from '@/server/api/error.js';
import { UserAuthService } from '@/core/UserAuthService.js';

export const meta = {
	requireCredential: true,

	secure: true,

	errors: {
		incorrectPassword: {
			message: 'Incorrect password.',
			code: 'INCORRECT_PASSWORD',
			id: '78d6c839-20c9-4c66-b90a-fc0542168b48',
		},

		authenticationFailed: {
			message: 'Authentication failed.',
			code: 'AUTHENTICATION_FAILED',
			id: 'e428f177-c6ae-4e91-9c7e-334b1836f9aa',
		},
	},

	res: {
		type: 'object',
		nullable: false,
		optional: false,
		properties: {
			qr: { type: 'string' },
			url: { type: 'string' },
			secret: { type: 'string' },
			label: { type: 'string' },
			issuer: { type: 'string' },
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		password: { type: 'string' },
		token: { type: 'string', nullable: true },
	},
	required: ['password'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.userProfilesRepository)
		private userProfilesRepository: UserProfilesRepository,

		private userAuthService: UserAuthService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const profile = await this.userProfilesRepository.findOneByOrFail({ userId: me.id });

			const passwordMatched = await bcrypt.compare(ps.password, profile.password ?? '');
			if (!passwordMatched) {
				throw new ApiError(meta.errors.incorrectPassword);
			}

			if (profile.twoFactorEnabled) {
				const token = ps.token;
				if (token == null) {
					throw new ApiError(meta.errors.authenticationFailed);
				}

				await this.userAuthService.twoFactorAuthenticate(profile, token);
			}

			// Generate user's secret key
			const secret = new OTPAuth.Secret();

			const issued = await this.userProfilesRepository.update({
				userId: me.id,
				password: profile.password ?? IsNull(),
				twoFactorEnabled: profile.twoFactorEnabled,
				twoFactorSecret: profile.twoFactorSecret ?? IsNull(),
			}, { twoFactorTempSecret: secret.base32 });
			if (!issued.affected) throw new ApiError(meta.errors.authenticationFailed);

			return totpRegistrationData(secret, me.username, this.config.host);
		});
	}
}
