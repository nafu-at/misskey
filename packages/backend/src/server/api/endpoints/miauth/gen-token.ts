/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { MiAccessToken, MiUser, type AccessTokensRepository } from '@/models/_.js';
import { IdService } from '@/core/IdService.js';
import { NotificationService } from '@/core/NotificationService.js';
import { secureRndstr } from '@/misc/secure-rndstr.js';
import { DI } from '@/di-symbols.js';
import { RoleService } from '@/core/RoleService.js';
import { ApiError, enrollmentRequired } from '../../error.js';

export const meta = {
	tags: ['auth'],

	requireCredential: true,

	secure: true,

	res: {
		type: 'object',
		optional: false, nullable: false,
		properties: {
			token: {
				type: 'string',
				optional: false, nullable: false,
			},
		},
	},

	errors: {
		tooManyAccessTokens: {
			message: 'Too many access tokens',
			code: 'TOO_MANY_ACCESS_TOKENS',
			id: 'eb37e2f9-5475-46c3-805a-803805e81d3f',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		session: { type: 'string', nullable: true },
		name: { type: 'string', nullable: true },
		description: { type: 'string', nullable: true },
		iconUrl: { type: 'string', nullable: true },
		permission: { type: 'array', uniqueItems: true, items: {
			type: 'string',
		} },
	},
	required: ['session', 'permission'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.accessTokensRepository)
		private accessTokensRepository: AccessTokensRepository,

		private roleService: RoleService,
		private idService: IdService,
		private notificationService: NotificationService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const { accessTokenLimit } = await this.roleService.getUserPolicies(me.id);
			const accessToken = secureRndstr(32);
			const now = new Date();

			await this.accessTokensRepository.manager.transaction(async (manager) => {
				// Serialize issuance for this user, including their first token.
				const owner = await manager.findOne(MiUser, {
					select: { id: true },
					where: { id: me.id, token: me.token! },
					lock: { mode: 'pessimistic_write' },
				});
				if (!owner) throw new ApiError(enrollmentRequired);
				if (await manager.countBy(MiAccessToken, { userId: me.id }) >= accessTokenLimit) {
					throw new ApiError(meta.errors.tooManyAccessTokens);
				}
				await manager.insert(MiAccessToken, {
					id: this.idService.gen(now.getTime()),
					lastUsedAt: now,
					session: ps.session,
					userId: me.id,
					token: accessToken,
					hash: accessToken,
					name: ps.name,
					description: ps.description,
					iconUrl: ps.iconUrl,
					permission: ps.permission,
				});
			});

			// アクセストークンが生成されたことを通知
			this.notificationService.createNotification(me.id, 'createToken', {});

			return {
				token: accessToken,
			};
		});
	}
}
