/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { AccessTokenService } from '@/core/AccessTokenService.js';
import { ApiError } from '../../error.js';

export const meta = {
	description: 'Revoke an access token of the authenticated user. Requires credential. When called with an access token (third-party app), only the token currently in use can be revoked.',

	tags: ['account'],
	requireCredential: true,
	kind: null,

	errors: {
		permissionDenied: {
			message: 'Permission denied.',
			code: 'PERMISSION_DENIED',
			id: 'fc20d118-5705-4462-b6c5-2b5b43092cf3',
			httpStatusCode: 403,
		},
	},
} as const;

export const paramDef = {
	anyOf: [
		{
			type: 'object',
			properties: {
				tokenId: { type: 'string', format: 'misskey:id' },
			},
			required: ['tokenId'],
		},
		{
			type: 'object',
			properties: {
				token: { type: 'string', nullable: true },
			},
			required: ['token'],
		},
	],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private accessTokenService: AccessTokenService,
	) {
		super(meta, paramDef, async (ps, me, token) => {
			if (!('tokenId' in ps) && !ps.token) return;
			const target = 'tokenId' in ps ? { id: ps.tokenId } : { token: ps.token! };

			// サードパーティアプリ (アクセストークン) からのリクエストでは、いま使われているトークン自身のみ失効できる
			if (token != null) {
				const targetId = await this.accessTokenService.findOwnedId(target, me.id);
				if (targetId == null) return;
				if (targetId !== token.id) throw new ApiError(meta.errors.permissionDenied);
				await this.accessTokenService.revoke({ id: targetId, userId: me.id });
				return;
			}

			await this.accessTokenService.revoke({ ...target, userId: me.id });
		});
	}
}
