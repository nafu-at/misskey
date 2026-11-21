/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import bcrypt from 'bcryptjs';
import { Inject, Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import type { UserProfilesRepository } from '@/models/_.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { DI } from '@/di-symbols.js';
import { ApiError } from '@/server/api/error.js';
import { RoleService } from '@/core/RoleService.js';
import { UserAuthService } from '@/core/UserAuthService.js';

export const meta = {
	requireCredential: true,

	secure: true,

	errors: {
		requiredByRole: {
			message: 'Your role requires two-factor authentication.',
			code: 'TWO_FACTOR_REQUIRED_BY_ROLE',
			kind: 'permission',
			id: '0d549d1f-735a-45b7-bd53-cc6f7fa48650',
		},
		incorrectPassword: {
			message: 'Incorrect password.',
			code: 'INCORRECT_PASSWORD',
			id: '7add0395-9901-4098-82f9-4f67af65f775',
		},

		authenticationFailed: {
			message: 'Authentication failed.',
			code: 'AUTHENTICATION_FAILED',
			id: '1b99d9c1-629c-41f9-9315-b27ee876f498',
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
		@Inject(DI.userProfilesRepository)
		private userProfilesRepository: UserProfilesRepository,

		private userEntityService: UserEntityService,
		private userAuthService: UserAuthService,
		private roleService: RoleService,
		private globalEventService: GlobalEventService,
	) {
		super(meta, paramDef, async (ps, me) => {
			if ((await this.roleService.getUserPolicies(me.id)).required2fa) {
				throw new ApiError(meta.errors.requiredByRole);
			}
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

			await this.userProfilesRepository.update(me.id, {
				twoFactorSecret: null,
				twoFactorTempSecret: null,
				twoFactorBackupSecret: null,
				twoFactorEnabled: false,
				usePasswordLessLogin: false,
			});

			// Publish meUpdated event
			this.globalEventService.publishMainStream(me.id, 'meUpdated', await this.userEntityService.pack(me.id, me, {
				schema: 'MeDetailed',
				includeSecrets: true,
			}));
		});
	}
}
