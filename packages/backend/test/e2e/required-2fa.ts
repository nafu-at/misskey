/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import * as OTPAuth from 'otpauth';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { loadConfig } from '@/config.js';
import { api, connectStream, createAppToken, relativeFetch, role, signup, sendEnvUpdateRequest, uploadFile } from '../utils.js';
import type { entities } from 'misskey-js';

describe('Role-required two-factor enrollment', () => {
	let root: entities.SignupResponse;
	let required: entities.Role;
	const redis = new Redis(loadConfig().redis);
	const password = 'test';

	beforeAll(async () => {
		root = await signup({ username: 'admin' });
		required = await role(root, {}, { required2fa: { useDefault: false, priority: 1, value: true } });
		await sendEnvUpdateRequest({ key: 'MISSKEY_TEST_CHECK_DUPLICATED_TOTP', value: '1' });
	});

	afterAll(async () => {
		await sendEnvUpdateRequest({ key: 'MISSKEY_TEST_CHECK_DUPLICATED_TOTP' });
		await redis.quit();
	});

	async function assign(user: entities.SignupResponse) {
		expect((await api('admin/roles/assign', { roleId: required.id, userId: user.id }, root)).status).toBe(204);
	}

	async function begin(user: entities.SignupResponse) {
		const res = await api('signin-flow', { username: user.username, password });
		assert.equal(res.status, 200);
		assert.ok(!res.body.finished && res.body.next === 'enroll-2fa');
		assert.ok(!('i' in res.body) && !('token' in res.body));
		return res.body;
	}

	function confirm(enrollment: entities.TwoFactorEnrollment) {
		return api('signin-enroll-2fa', { ticket: enrollment.ticket, code: OTPAuth.URI.parse(enrollment.url).generate() });
	}

	test('requires enrollment on existing sessions and grants access only with the newly issued credentials', async () => {
		const user = await signup();
		expect((await api('signin-flow', { username: user.username, password })).body.finished).toBe(true);
		const app = { token: await createAppToken(user, ['read:account']) };
		const ws = await connectStream(app, 'main', () => {});
		const closed = once(ws, 'close');
		await assign(user);
		expect((await closed)[0]).toBe(1008);
		for (const credentials of [user, app]) {
			const res = await api('i', {}, credentials);
			expect(res.status).toBe(403);
			expect(res.body).toMatchObject({ error: { code: 'TWO_FACTOR_ENROLLMENT_REQUIRED' } });
		}
		expect((await api('meta', {})).status).toBe(200);
		expect((await uploadFile(user)).status).toBe(403);
		await expect(connectStream(user, 'main', () => {})).rejects.toMatchObject({ statusCode: 403 });
		expect((await relativeFetch('oauth/api/userinfo', { headers: { Authorization: 'Bearer ' + app.token } })).status).toBe(403);
		const introspection = await relativeFetch('oauth/token/introspect', { method: 'POST', body: new URLSearchParams({ token: app.token }) });
		expect(await introspection.json()).toMatchObject({ active: false });
		const first = await begin(user);
		const second = await begin(user);
		const results = await Promise.all([confirm(first), confirm(first), confirm(second)]);
		expect(results.map(r => r.status).sort()).toEqual([200, 403, 403]);
		const success = results.find(r => r.status === 200)!.body;
		expect(success.id).toBe(user.id);
		expect(success.backupCodes).toHaveLength(20);
		expect(success.i === user.token).toBe(false);
		expect((await confirm(first)).status).toBe(403);
		for (const credentials of [user, app]) {
			expect((await api('i', {}, credentials)).status).toBe(401);
		}
		const enrolled = { token: success.i };
		expect((await api('i', {}, enrolled)).body.twoFactorEnabled).toBe(true);
		expect((await api('i/2fa/unregister', { password }, enrolled)).body).toMatchObject({ error: { code: 'TWO_FACTOR_REQUIRED_BY_ROLE' } });
		expect((await api('signin-flow', { username: user.username, password })).body).toMatchObject({ finished: false, next: 'totp' });
		const backupLogin = () => api('signin-flow', { username: user.username, password, token: success.backupCodes[0] });
		const backupResults = await Promise.all([backupLogin(), backupLogin()]);
		expect(backupResults.filter(res => res.status === 200 && res.body.finished)).toHaveLength(1);
		const renewal = await api('i/2fa/register', { password, token: success.backupCodes[1] }, enrolled);
		assert.equal(renewal.status, 200);
		const incorrect = await api('i/2fa/done', { token: 'incorrect' }, enrolled);
		expect(incorrect.status).toBe(400);
		expect(incorrect.body).toMatchObject({ error: { code: 'INVALID_TWO_FACTOR_CODE' } });
		const renewed = await api('i/2fa/done', { token: OTPAuth.URI.parse(renewal.body.url).generate() }, enrolled);
		expect(renewed.status).toBe(200);
		expect((await api('admin/unset-mfa', { userId: user.id }, root)).status).toBe(204);
		expect((await api('i', {}, enrolled)).status).toBe(401);
		expect((await confirm(await begin(user))).status).toBe(200);
	});

	test('withholds pending MiAuth and legacy app approvals until clients reauthorize', async () => {
		const user = await signup();
		const app = await api('app/create', { name: 'legacy', description: 'test fixture', permission: ['read:account'] }, user);
		const appSecret = app.body.secret!;
		const session = await api('auth/session/generate', { appSecret });
		const token = session.body.token;
		expect((await api('auth/accept', { token }, user)).status).toBe(204);
		const id = randomUUID();
		expect((await api('miauth/gen-token', { session: id, permission: ['read:account'] }, user)).status).toBe(200);
		await assign(user);
		const collect = () => relativeFetch(`api/miauth/${id}/check`, { method: 'POST' }).then(r => r.json());
		expect(await collect()).toMatchObject({ ok: false });
		expect((await api('auth/session/userkey', { appSecret, token })).body).toMatchObject({ error: { code: 'PENDING_SESSION' } });
		const enrolled = { token: (await confirm(await begin(user))).body.i };
		expect(await collect()).toMatchObject({ ok: false });
		expect((await api('auth/session/userkey', { appSecret, token })).body).toMatchObject({ error: { code: 'NO_SUCH_SESSION' } });
		const fresh = await createAppToken(enrolled, ['read:account']);
		expect((await api('i', {}, { token: fresh })).status).toBe(200);
	});

	test.each(['jwt', 'saml'] as const)('%s requires enrollment before releasing an assertion', async type => {
		const user = await signup();
		const provider = await api('admin/sso/create', {
			type, issuer: 'https://example.org', acsUrl: 'https://example.org/return', audience: ['https://example.org'],
			binding: 'post', useCertificate: true, signatureAlgorithm: 'RS256',
		}, root);
		assert.equal(provider.status, 200);
		async function beginConsent() {
			const transactionId = randomUUID();
			await redis.set(`sso:${type}:transaction:${transactionId}`, JSON.stringify({
				serviceId: provider.body.id, flowResult: { extract: { request: { id: '_request' } } }, relayState: 'consent',
			}), 'EX', 60);
			return transactionId;
		}
		function consent(transactionId: string, token: string) {
			return relativeFetch(`sso/${type}/authorize`, {
				method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ transaction_id: transactionId, login_token: token }),
			});
		}
		async function issueJwt(token: string) {
			const response = await consent(await beginConsent(), token);
			assert.equal(response.status, 200);
			return ((await response.json()) as { context: { jwt: string } }).context.jwt;
		}
		const verify = (jwt: string) => relativeFetch(`sso/jwt/api/verify/${provider.body.id}`, {
			method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jwt }),
		});
		const originalJwt = type === 'jwt' ? await issueJwt(user.token) : null;
		if (originalJwt) expect((await verify(originalJwt)).status).toBe(200);
		await assign(user);
		const transactionId = await beginConsent();
		const expiredId = await beginConsent();
		const denied = await consent(transactionId, user.token);
		expect(denied.status).toBe(403);
		expect(await denied.json()).toMatchObject({ error: { code: 'TWO_FACTOR_ENROLLMENT_REQUIRED' } });
		if (originalJwt) expect((await verify(originalJwt)).status).toBe(403);
		const enrolled = await confirm(await begin(user));
		await redis.expire(`sso:${type}:transaction:${expiredId}`, 0);
		expect((await consent(expiredId, enrolled.body.i)).status).toBe(403);
		expect((await consent(transactionId, enrolled.body.i)).status).toBe(200);
		expect((await consent(transactionId, enrolled.body.i)).status).toBe(403);
		if (originalJwt) {
			const revoked = await verify(originalJwt);
			expect(revoked.status).toBe(400);
			expect(await revoked.json()).toMatchObject({ error: { code: 'INVALID_JWT' } });
			expect((await verify(await issueJwt(enrolled.body.i))).status).toBe(200);
		}
	});

	test('limits the ticket lifetime and attempts and invalidates it after a password reset', async () => {
		const user = await signup();
		await assign(user);
		const limited = await begin(user);
		const key = '2fa:enroll:' + createHash('sha256').update(limited.ticket).digest('hex');
		const ttl = await redis.ttl(key);
		expect(ttl).toBeGreaterThan(0);
		expect(ttl).toBeLessThanOrEqual(300);
		const totp = OTPAuth.URI.parse(limited.url) as OTPAuth.TOTP;
		let invalid = '000000';
		while (totp.validate({ token: invalid, window: 2 }) !== null) invalid = String(Number(invalid) + 1).padStart(6, '0');
		for (let attempt = 0; attempt < 5; attempt++) {
			expect((await api('signin-enroll-2fa', { ticket: limited.ticket, code: invalid })).status).toBe(403);
		}
		expect((await confirm(limited)).status).toBe(403);
		const expired = await begin(user);
		await redis.expire('2fa:enroll:' + createHash('sha256').update(expired.ticket).digest('hex'), 0);
		expect((await confirm(expired)).status).toBe(403);
		const stale = await begin(user);
		expect((await api('admin/reset-password', { userId: user.id }, root)).status).toBe(200);
		expect((await confirm(stale)).status).toBe(403);
	});

	test('applies to root, newly created accounts and admin-created accounts', async () => {
		await assign(root);
		expect((await relativeFetch('queue/', { headers: { Cookie: 'token=' + root.token } })).status).toBe(403);
		const result = await confirm(await begin(root));
		assert.equal(result.status, 200);
		root.token = result.body.i;
		expect((await api('admin/unset-mfa', { userId: root.id }, root)).body).toMatchObject({ error: { code: 'ACCESS_DENIED' } });
		expect((await relativeFetch('api/admin/roles/update-default-policies', {
			method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ i: root.token, policies: { required2fa: true } }),
		})).status).toBe(204);
		try {
			const user = await api('signup', { username: 'requiredsignup', password });
			assert.equal(user.status, 200);
			assert.ok('ticket' in user.body && !('token' in user.body));
			expect((await confirm(user.body)).status).toBe(200);
			const created = await api('admin/accounts/create', { username: 'createdbyadmin', password }, root);
			assert.equal(created.status, 200);
			expect(created.body.token).toBeNull();
		} finally {
			await api('admin/roles/update-default-policies', { policies: {} }, root);
		}
	});
});
