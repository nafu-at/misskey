/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Test } from '@nestjs/testing';
import { expect, test, vi } from 'vitest';
import { QueueService } from '@/core/QueueService.js';

test('別のワーカーが定期ジョブを削除しても残りの旧ジョブを整理する', async () => {
	const systemQueue = {
		upsertJobScheduler: vi.fn(),
		getJobSchedulers: async () => [undefined, { key: 'tickCharts' }, { key: 'obsolete' }],
		removeJobScheduler: vi.fn(),
	};
	const app = await Test.createTestingModule({
		providers: [QueueService, { provide: 'queue:system', useValue: systemQueue }],
	}).useMocker(() => ({})).compile();
	try {
		expect(systemQueue.removeJobScheduler.mock.calls).toEqual([['obsolete']]);
	} finally {
		await app.close();
	}
});
