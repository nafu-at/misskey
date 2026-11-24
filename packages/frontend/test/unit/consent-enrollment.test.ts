/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { host } from '@@/js/config.js';
import { reauthenticateConsentAccount, requestTwoFactorSignin, shouldKeepConsentOnReload } from '@/accounts.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { miLocalStorage } from '@/local-storage.js';

const state = vi.hoisted(() => ({
	me: { id: 'a', username: 'alice', token: 'old' },
	popup: vi.fn(), reload: vi.fn(), set: vi.fn(),
}));
vi.mock('@/i.js', async importOriginal => {
	const actual = await importOriginal<typeof import('@/i.js')>();
	return { ...actual, cachedAccount: state.me, get $i() { return actual.isConsentPage() ? null : state.me; } };
});
vi.mock('@/os.js', () => ({ popup: state.popup }));
vi.mock('@/instance.js', () => ({ instance: {} }));
vi.mock('@/utility/unison-reload.js', () => ({ unisonReload: state.reload }));
vi.mock('@/preferences.js', () => ({ prefer: { s: { accounts: [] }, commit: vi.fn() } }));
vi.mock('@/store.js', () => ({ store: { s: { accountTokens: {}, accountInfos: {} }, set: state.set } }));

function consentPage(name: string) {
	const marker = window.document.createElement('meta');
	marker.name = name;
	window.document.head.appendChild(marker);
	return marker;
}

function signin(id: string, username: string) {
	vi.spyOn(window, 'fetch').mockResolvedValueOnce(Response.json({ id, username }));
	state.popup.mockImplementationOnce((_component, _props, events) => events.done({ finished: true, id, i: 'renewed' }));
}

beforeEach(() => {
	vi.clearAllMocks();
	state.me.token = 'old';
	miLocalStorage.setItemAsJson('account', state.me);
});

afterEach(() => {
	vi.restoreAllMocks();
	window.document.head.querySelectorAll('meta[name^="misskey:"]').forEach(marker => marker.remove());
	window.localStorage.clear();
	window.document.cookie = 'token=; max-age=0; path=/';
});

test.each(['misskey:oauth:client-name', 'misskey:sso:service-name'])('%s keeps consent through enrollment and updates the current credential', async name => {
	consentPage(name);
	vi.resetModules();
	const boot = await vi.importActual<typeof import('@/i.js')>('@/i.js');
	expect(boot.$i).toBeNull();
	expect(boot.cachedAccount?.token).toBe('old');
	vi.spyOn(window, 'fetch').mockResolvedValueOnce(Response.json({ error: { code: 'TWO_FACTOR_ENROLLMENT_REQUIRED' } }, { status: 403 }));
	await expect(misskeyApi('i', {}, 'old')).rejects.toMatchObject({ code: 'TWO_FACTOR_ENROLLMENT_REQUIRED' });
	expect(state.reload).not.toHaveBeenCalled();
	expect(miLocalStorage.getItemAsJson('account')).toEqual(state.me);
	signin('a', 'alice');
	await expect(reauthenticateConsentAccount(state.me, 'old')).resolves.toBe('renewed');
	expect(state.me.token).toBe('renewed');
	expect(miLocalStorage.getItemAsJson('account')).toEqual(state.me);
	expect(window.document.cookie).toContain('token=renewed');
});

test('reauthenticates a selected secondary account without switching the current account', async () => {
	consentPage('misskey:oauth:client-name');
	const other = { id: 'b', username: 'bob' };
	signin('b', 'bob');
	await expect(reauthenticateConsentAccount(other, 'old-b')).resolves.toBe('renewed');
	expect(state.set).toHaveBeenCalledWith('accountTokens', { [host + '/b']: 'renewed' });
	expect(miLocalStorage.getItemAsJson('account')).toEqual({ id: 'a', username: 'alice', token: 'old' });
	expect(window.document.cookie).not.toContain('token=renewed');
});

test('cancellation or signing in as another account leaves the decision pending', async () => {
	consentPage('misskey:sso:service-name');
	state.popup.mockImplementationOnce((_component, _props, events) => events.cancelled());
	await expect(reauthenticateConsentAccount(state.me, 'old')).resolves.toBeNull();
	state.popup.mockImplementationOnce((_component, _props, events) => events.done({ finished: true, id: 'other', i: 'other' }));
	await expect(reauthenticateConsentAccount(state.me, 'old')).resolves.toBeNull();
	expect(state.set).not.toHaveBeenCalled();
	expect(state.me.token).toBe('old');
});

test('keeps the transaction for same-account enrollment in another tab and honors logout and account switches', () => {
	expect(shouldKeepConsentOnReload('/?required2fa=1')).toBe(false);
	consentPage('misskey:sso:service-name');
	expect(shouldKeepConsentOnReload('/?required2fa=1')).toBe(true);
	miLocalStorage.setItemAsJson('account', { id: 'a', token: 'renewed' });
	expect(shouldKeepConsentOnReload(null)).toBe(true);
	expect(shouldKeepConsentOnReload('/')).toBe(false);
	miLocalStorage.setItemAsJson('account', { id: 'b', token: 'other' });
	expect(shouldKeepConsentOnReload(null)).toBe(false);
	miLocalStorage.removeItem('account');
	expect(shouldKeepConsentOnReload(null)).toBe(false);
});

test('keeps the existing enrollment redirect outside consent', async () => {
	await requestTwoFactorSignin('old');
	expect(state.reload).toHaveBeenCalledWith('/?required2fa=1');
	expect(miLocalStorage.getItem('account')).toBeNull();
});
