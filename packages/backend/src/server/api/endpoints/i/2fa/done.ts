/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { generateBackupCodes } from '@/core/TwoFactorEnrollmentService.js';
import { Inject, Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import type { UserProfilesRepository } from '@/models/_.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { DI } from '@/di-symbols.js';
import { UserAuthService } from '@/core/UserAuthService.js';
import { ApiError } from '@/server/api/error.js';

export const meta = {
	requireCredential: true,

	secure: true,

	errors: {
		invalidCode: {
			message: 'Invalid or already used authentication code.',
			code: 'INVALID_TWO_FACTOR_CODE',
			id: '4b27fc5c-d941-459f-bf7c-d61324cb71bc',
		},
		invalidRegistration: {
			message: 'Two-factor registration has expired or changed. Please start again.',
			code: 'INVALID_TWO_FACTOR_REGISTRATION',
			id: '4b27fc5c-41fd-4462-ac2f-b05fcd306ded',
		},
	},

	res: {
		type: 'object',
		properties: {
			backupCodes: {
				type: 'array',
				optional: false,
				items: {
					type: 'string',
				},
			},
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		token: { type: 'string' },
	},
	required: ['token'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.userProfilesRepository)
		private userProfilesRepository: UserProfilesRepository,

		private userEntityService: UserEntityService,
		private userAuthService: UserAuthService,
		private globalEventService: GlobalEventService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const token = ps.token.replace(/\s/g, '');

			const profile = await this.userProfilesRepository.findOneByOrFail({ userId: me.id });

			if (profile.twoFactorTempSecret == null) {
				throw new ApiError(meta.errors.invalidRegistration);
			}

			if (!await this.userAuthService.validateOtp(profile.userId, profile.twoFactorTempSecret, token)) {
				throw new ApiError(meta.errors.invalidCode);
			}

			const backupCodes = generateBackupCodes();

			const update = await this.userProfilesRepository.update({ userId: me.id, twoFactorTempSecret: profile.twoFactorTempSecret }, {
				twoFactorSecret: profile.twoFactorTempSecret,
				twoFactorTempSecret: null,
				twoFactorBackupSecret: backupCodes,
				twoFactorEnabled: true,
			});

			if (!update.affected) throw new ApiError(meta.errors.invalidRegistration);

			// Publish meUpdated event
			this.globalEventService.publishMainStream(me.id, 'meUpdated', await this.userEntityService.pack(me.id, me, {
				schema: 'MeDetailed',
				includeSecrets: true,
			}));

			return {
				backupCodes: backupCodes,
			};
		});
	}
}
