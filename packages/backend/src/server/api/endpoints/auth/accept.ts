/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as crypto from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { MiApp, MiAuthSession, MiAccessToken, MiUser, type AuthSessionsRepository } from '@/models/_.js';
import { IdService } from '@/core/IdService.js';
import { secureRndstr } from '@/misc/secure-rndstr.js';
import { DI } from '@/di-symbols.js';
import { ApiError, enrollmentRequired } from '../../error.js';

export const meta = {
	tags: ['auth'],

	requireCredential: true,

	secure: true,

	errors: {
		noSuchSession: {
			message: 'No such session.',
			code: 'NO_SUCH_SESSION',
			id: '9c72d8de-391a-43c1-9d06-08d29efde8df',
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
		@Inject(DI.authSessionsRepository)
		private authSessionsRepository: AuthSessionsRepository,

		private idService: IdService,
	) {
		super(meta, paramDef, async (ps, me) => {
			await this.authSessionsRepository.manager.transaction(async manager => {
				const owner = await manager.findOne(MiUser, {
					select: { id: true }, where: { id: me.id, token: me.token! }, lock: { mode: 'pessimistic_write' },
				});
				if (!owner) throw new ApiError(enrollmentRequired);
				// Fetch token
				const session = await manager.findOneBy(MiAuthSession, { token: ps.token });

				if (session == null) {
					throw new ApiError(meta.errors.noSuchSession);
				}

				const accessToken = secureRndstr(32);

				// Fetch exist access token
				const exist = await manager.exists(MiAccessToken, {
					where: {
						appId: session.appId,
						userId: me.id,
					},
				});

				if (!exist) {
					const app = await manager.findOneByOrFail(MiApp, { id: session.appId });

					// Generate Hash
					const sha256 = crypto.createHash('sha256');
					sha256.update(accessToken + app.secret);
					const hash = sha256.digest('hex');

					const now = new Date();

					await manager.insert(MiAccessToken, {
						id: this.idService.gen(now.getTime()),
						lastUsedAt: now,
						appId: session.appId,
						userId: me.id,
						token: accessToken,
						hash: hash,
					});
				}

				// Update session
				await manager.update(MiAuthSession, session.id, {
					userId: me.id,
				});
			});
		});
	}
}
