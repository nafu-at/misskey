/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { In } from 'typeorm';
import { DI } from '@/di-symbols.js';
import { MiAccessToken, type AccessTokensRepository } from '@/models/_.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';

type TokenSelector = Pick<MiAccessToken, 'id'> | Pick<MiAccessToken, 'token'>;

@Injectable()
export class AccessTokenService {
	constructor(
		@Inject(DI.accessTokensRepository)
		private readonly accessTokensRepository: AccessTokensRepository,
		private readonly globalEventService: GlobalEventService,
	) {}

	public async revoke(target: TokenSelector & { userId?: string }): Promise<void> {
		const result = await this.accessTokensRepository.createQueryBuilder()
			.delete()
			.where(target)
			.returning(['id'])
			.execute();
		for (const row of result.raw as Pick<MiAccessToken, 'id'>[]) {
			this.globalEventService.publishInternalEvent('accessTokenRevoked', { id: row.id });
		}
	}

	public async findOwnedId(target: TokenSelector, userId: string): Promise<string | undefined> {
		const runner = this.accessTokensRepository.manager.connection.createQueryRunner('master');
		try {
			const row = await runner.manager.findOne(MiAccessToken, { select: { id: true }, where: { ...target, userId } });
			return row?.id;
		} finally {
			await runner.release();
		}
	}

	public async findActiveIds(ids: string[]): Promise<Set<string>> {
		// A read replica can still see the token after revocation on the primary.
		const runner = this.accessTokensRepository.manager.connection.createQueryRunner('master');
		try {
			const rows = await runner.manager.find(MiAccessToken, { select: { id: true }, where: { id: In(ids) } });
			return new Set(rows.map(row => row.id));
		} finally {
			await runner.release();
		}
	}
}
