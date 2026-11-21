/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { beforeAll, describe, expect, test } from 'vitest';
import { api, role, signup } from '../utils.js';
import type { RolePolicies } from '@/core/RoleService.js';
import type { entities } from 'misskey-js';

describe('API のロールポリシー', () => {
	let admin: entities.SignupResponse;

	beforeAll(async () => {
		admin = await signup({ username: 'admin' });
	});

	async function assignPolicies(user: entities.SignupResponse, policies: Partial<RolePolicies>) {
		const assignedRole = await role(admin, {}, Object.fromEntries(Object.entries(policies).map(([key, value]) => [
			key, { useDefault: false, priority: 1, value },
		])));
		const assigned = await api('admin/roles/assign', { userId: user.id, roleId: assignedRole.id }, admin);
		expect(assigned.status).toBe(204);
	}

	test.each([
		{ canCreateContent: false, canCreateChannel: true, status: 403 },
		{ canCreateContent: true, canCreateChannel: false, status: 403 },
		{ canCreateContent: true, canCreateChannel: true, status: 200 },
	])('チャンネル作成は canCreateContent=$canCreateContent、canCreateChannel=$canCreateChannel のとき $status', async ({ canCreateContent, canCreateChannel, status }) => {
		const user = await signup();
		await assignPolicies(user, { canCreateContent, canCreateChannel });
		const result = await api('channels/create', { name: 'test' }, user);
		expect(result.status).toBe(status);
		if (status === 403) expect(result.body).toMatchObject({ error: { code: 'ROLE_PERMISSION_DENIED' } });
	});

	test.each(['canCreateContent', 'canUpdateContent', 'canDeleteContent', 'canScheduleNote'] as const)('%s を無効にすると対応する操作だけを拒否する', async (disabled) => {
		const user = await signup();
		const folder = await api('drive/folders/create', { name: 'before' }, user);
		expect(folder.status).toBe(200);
		await assignPolicies(user, { [disabled]: false });

		const operations = [
			['canCreateContent', 200, await api('drive/folders/create', { name: 'other' }, user)],
			['canUpdateContent', 200, await api('drive/folders/update', { folderId: folder.body.id, name: 'after' }, user)],
			['canDeleteContent', 204, await api('drive/folders/delete', { folderId: folder.body.id }, user)],
			['canScheduleNote', 200, await api('notes/scheduled/list', {}, user)],
		] as const;
		for (const [policy, successStatus, result] of operations) {
			if (policy === disabled) {
				expect(result.status).toBe(403);
				expect(result.body).toMatchObject({ error: { code: 'ROLE_PERMISSION_DENIED' } });
			} else {
				expect(result.status).toBe(successStatus);
			}
		}
	});
});
