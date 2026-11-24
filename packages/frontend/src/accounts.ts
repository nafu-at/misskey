/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { defineAsyncComponent, ref } from 'vue';
import * as Misskey from 'misskey-js';
import { apiUrl, host } from '@@/js/config.js';
import { generateClientTransactionId, misskeyApi } from '@/utility/misskey-api.js';
import type { MenuItem } from '@/types/menu.js';
import { showSuspendedDialog } from '@/utility/show-suspended-dialog.js';
import { i18n } from '@/i18n.js';
import { miLocalStorage } from '@/local-storage.js';
import { popup, success, alert } from '@/os.js';
import { unisonReload, reloadChannel } from '@/utility/unison-reload.js';
import { prefer } from '@/preferences.js';
import { store } from '@/store.js';
import { $i, cachedAccount, isConsentPage } from '@/i.js';

type AccountWithToken = Misskey.entities.MeDetailed & { token: string };
export type ConsentAccount = Pick<AccountWithToken, 'id' | 'username'>;

export async function getAccounts(): Promise<{
	host: string;
	id: Misskey.entities.User['id'];
	username: Misskey.entities.User['username'];
	user?: Misskey.entities.MeDetailed | null;
	token: string | null;
}[]> {
	const tokens = store.s.accountTokens;
	const accountInfos = store.s.accountInfos;
	const accounts = prefer.s.accounts;
	return accounts.map(([host, user]) => ({
		host,
		id: user.id,
		username: user.username,
		user: accountInfos[host + '/' + user.id],
		token: tokens[host + '/' + user.id] ?? null,
	}));
}

async function addAccount(host: string, user: Misskey.entities.MeDetailed, token: AccountWithToken['token']) {
	const key = host + '/' + user.id;
	store.set('accountTokens', { ...store.s.accountTokens, [key]: token });
	store.set('accountInfos', { ...store.s.accountInfos, [key]: user });

	if (!prefer.s.accounts.some(x => x[0] === host && x[1].id === user.id)) {
		prefer.commit('accounts', [...prefer.s.accounts, [host, { id: user.id, username: user.username }]]);
	}
}

export async function removeAccount(host: string, id: AccountWithToken['id']) {
	const tokens = JSON.parse(JSON.stringify(store.s.accountTokens));
	delete tokens[host + '/' + id];
	store.set('accountTokens', tokens);
	const accountInfos = JSON.parse(JSON.stringify(store.s.accountInfos));
	delete accountInfos[host + '/' + id];
	store.set('accountInfos', accountInfos);

	prefer.commit('accounts', prefer.s.accounts.filter(x => x[0] !== host || x[1].id !== id));
}

let redirectingToEnrollment = false;
const enrollmentSigninPath = '/?required2fa=1';

export function shouldKeepConsentOnReload(path: string | null): boolean {
	if (!isConsentPage()) return false;
	if (path === enrollmentSigninPath) return true;
	// A same-account sign-in in another tab must not replace the consent document.
	// A sign-out or a switch to a different account still takes effect here.
	return path === null && cachedAccount !== null && miLocalStorage.getItemAsJson('account')?.id === cachedAccount.id;
}

export async function requestTwoFactorSignin(token: string) {
	if (!$i || token !== $i.token || redirectingToEnrollment) return;
	redirectingToEnrollment = true;
	const saved = miLocalStorage.getItemAsJson('account');
	if (saved?.id !== $i.id || saved.token !== token) {
		// Another tab already replaced this credential while the request was in flight.
		window.location.reload();
		return;
	}
	miLocalStorage.removeItem('account');
	window.document.cookie = 'token=; max-age=0; path=/';
	await removeAccount(host, $i.id);
	unisonReload(enrollmentSigninPath);
}

const isAccountDeleted = Symbol('isAccountDeleted');
const enrollmentRequired = Symbol('enrollmentRequired');

async function removeAccountByToken(token: string) {
	const entry = Object.entries(store.s.accountTokens).find(([, value]) => value === token);
	if (!entry) return;
	const [key] = entry;
	const separatorIndex = key.lastIndexOf('/');
	if (separatorIndex === -1) return;
	const accountHost = key.slice(0, separatorIndex);
	const accountId = key.slice(separatorIndex + 1);
	await removeAccount(accountHost, accountId);
}

function fetchAccount(token: string, id?: string, forceShowDialog?: boolean): Promise<Misskey.entities.MeDetailed> {
	return new Promise((done, fail) => {
		window.fetch(`${apiUrl}/i`, {
			method: 'POST',
			body: JSON.stringify({
				i: token,
			}),
			credentials: 'include',
			headers: {
				'Content-Type': 'application/json',
				'X-Client-Transaction-Id': generateClientTransactionId('accounts'),
			},
		})
			.then(res => new Promise<Misskey.entities.MeDetailed | { error: Record<string, any> }>((done2, fail2) => {
				if (res.status >= 500 && res.status < 600) {
					// サーバーエラー(5xx)の場合をrejectとする
					// （認証エラーなど4xxはresolve）
					return fail2(res);
				}
				res.json().then(done2, fail2);
			}))
			.then(async res => {
				if ('error' in res) {
					if (res.error.code === 'TWO_FACTOR_ENROLLMENT_REQUIRED') {
						await requestTwoFactorSignin(token);
						return fail(enrollmentRequired);
					}
					if (res.error.id === 'a8c724b3-6e9c-4b46-b1a8-bc3ed6258370') {
						// SUSPENDED
						if (forceShowDialog || $i && (token === $i.token || id === $i.id)) {
							await showSuspendedDialog();
						}
					} else if (res.error.id === 'e5b3b9f0-2b8f-4b9f-9c1f-8c5c1b2e1b1a') {
						// USER_IS_DELETED
						// アカウントが削除されている
						if (forceShowDialog || $i && (token === $i.token || id === $i.id)) {
							await alert({
								type: 'error',
								title: i18n.ts.accountDeleted,
								text: i18n.ts.accountDeletedDescription,
							});
						}
					} else if (res.error.id === 'b0a7f5f8-dc2f-4171-b91f-de88ad238e14') {
						// AUTHENTICATION_FAILED
						// トークンが無効化されていたりアカウントが削除されたりしている
						if (forceShowDialog || $i && (token === $i.token || id === $i.id)) {
							await alert({
								type: 'error',
								title: i18n.ts.tokenRevoked,
								text: i18n.ts.tokenRevokedDescription,
							});
						}
					} else {
						await alert({
							type: 'error',
							title: i18n.ts.failedToFetchAccountInformation,
							text: JSON.stringify(res.error),
						});
					}

					fail(isAccountDeleted);
				} else {
					done(res);
				}
			})
			.catch(fail);
	});
}

export function updateCurrentAccount(accountData: Misskey.entities.MeDetailed) {
	if (!$i) return;
	const token = $i.token;
	for (const key of Object.keys($i)) {
		delete $i[key as keyof typeof $i];
	}
	for (const [key, value] of Object.entries(accountData)) {
		($i[key as keyof typeof accountData] as any) = value;
	}
	store.set('accountInfos', { ...store.s.accountInfos, [host + '/' + $i.id]: $i });
	$i.token = token;
	miLocalStorage.setItem('account', JSON.stringify($i));
}

export function updateCurrentAccountPartial(accountData: Partial<Misskey.entities.MeDetailed>) {
	if (!$i) return;
	for (const [key, value] of Object.entries(accountData)) {
		($i[key as keyof typeof accountData] as any) = value;
	}

	store.set('accountInfos', { ...store.s.accountInfos, [host + '/' + $i.id]: $i });

	miLocalStorage.setItem('account', JSON.stringify($i));
}

export async function refreshCurrentAccount() {
	if (!$i) return;
	return fetchAccount($i.token, $i.id)
		.then(updateCurrentAccount)
		.catch(async reason => {
			if (reason === isAccountDeleted) {
				const { signout } = await import('@/signout.js');
				await signout();
			}
		});
}

function saveCurrentAccount(user: Misskey.entities.MeDetailed, token: string) {
	miLocalStorage.setItemAsJson('account', { ...user, token });
	window.document.cookie = `token=${token}; path=/; max-age=31536000`; // bull dashboardの認証とかで使う
}

export async function login(token: AccountWithToken['token'], redirect?: string) {
	const showing = ref(true);
	await popup(defineAsyncComponent(() => import('@/components/MkWaitingDialog.vue')), {
		success: false,
		showing: showing,
	}, {}, 'closed');

	const me = await fetchAccount(token, undefined, true).catch(async reason => {
		if (reason === isAccountDeleted) {
			await removeAccountByToken(token);
		}
		showing.value = false;
		if (reason === enrollmentRequired) {
			if ($i?.token !== token) {
				const account = (await getAccounts()).find(account => account.token === token);
				popup(defineAsyncComponent(() => import('@/components/MkSigninDialog.vue')), {
					initialUsername: account?.username,
					message: i18n.ts._2fa.enrollmentRequired,
				}, { done: res => login(res.i, redirect) }, 'closed');
			}
			return null;
		}
		throw reason;
	});
	if (!me) return;

	saveCurrentAccount(me, token);
	await addAccount(host, me, token);

	if (redirect) {
		// 他のタブは再読み込みするだけ
		reloadChannel.postMessage(null);
		// このページはredirectで指定された先に移動
		window.location.href = redirect;
		return;
	}

	unisonReload();
}

export async function switchAccount(host: string, id: string, initialUsername?: string) {
	const token = store.s.accountTokens[host + '/' + id];
	if (token) {
		login(token);
	} else {
		await popup(defineAsyncComponent(() => import('@/components/MkSigninDialog.vue')), {
			initialUsername,
		}, {
			done: async (res: Misskey.entities.SigninFlowResponse & { finished: true }) => {
				login(res.i);
			},
		}, 'closed');
	}
}

export async function getAccountMenu(opts: {
	includeCurrentAccount?: boolean;
	withExtraOperation: boolean;
	active?: Misskey.entities.User['id'];
	onChoose?: (account: Misskey.entities.MeDetailed) => void;
}) {
	if ($i == null) throw new Error('No current account');
	const me = $i;

	const callback = opts.onChoose;

	function createItem(accountHost: string, id: Misskey.entities.User['id'], username: Misskey.entities.User['username'], account: Misskey.entities.MeDetailed | null | undefined, token: string | null): MenuItem {
		if (account) {
			return {
				type: 'user',
				user: account,
				active: opts.active != null ? opts.active === id : false,
				action: () => {
					if (callback) {
						callback(account);
					} else {
						switchAccount(accountHost, id, username);
					}
				},
			};
		} else if (token != null) {
			return {
				type: 'button',
				text: username,
				active: opts.active != null ? opts.active === id : false,
				action: () => {
					if (callback) {
						fetchAccount(token, id).then(callback);
					} else {
						switchAccount(accountHost, id, username);
					}
				},
			};
		} else {
			return {
				type: 'button',
				text: username,
				active: opts.active != null ? opts.active === id : false,
				action: () => {
					const { dispose } = popup(defineAsyncComponent(() => import('@/components/MkSigninDialog.vue')), {
						initialUsername: username,
					}, {
						done: async (res: Misskey.entities.SigninFlowResponse & { finished: true }) => {
							store.set('accountTokens', { ...store.s.accountTokens, [accountHost + '/' + res.id]: res.i });

							if (callback) {
								fetchAccount(res.i, id).then(callback);
							} else {
								login(res.i);
							}
						},
						closed: () => dispose(),
					});
				},
			};
		}
	}

	const accountItems = (await getAccounts())
		.filter(account => account.id !== me.id)
		.map(account => createItem(account.host, account.id, account.username, account.user, account.token));

	if (opts.withExtraOperation) {
		return [{
			type: 'link' as const,
			text: i18n.ts.profile,
			to: `/@${$i.username}`,
			avatar: $i,
		}, { type: 'divider' as const }, ...(opts.includeCurrentAccount ? [createItem(host, $i.id, $i.username, $i, $i.token)] : []), ...accountItems, {
			type: 'parent' as const,
			icon: 'ti ti-plus',
			text: i18n.ts.addAccount,
			children: [{
				text: i18n.ts.existingAccount,
				action: () => {
					getAccountWithSigninDialog().then(res => {
						if (res != null) {
							success();
						}
					});
				},
			}, {
				text: i18n.ts.createAccount,
				action: () => {
					getAccountWithSignupDialog().then(res => {
						if (res != null) {
							login(res.token);
						}
					});
				},
			}],
		}, {
			type: 'link' as const,
			icon: 'ti ti-users',
			text: i18n.ts.manageAccounts,
			to: '/settings/accounts',
		}];
	}

	return [...(opts.includeCurrentAccount ? [createItem(host, $i.id, $i.username, $i, $i.token)] : []), ...accountItems];
}

export function getAccountWithSigninDialog(initialUsername?: string, expectedId?: string): Promise<{ id: string, token: string, user: Misskey.entities.MeDetailed } | null> {
	return new Promise((resolve) => {
		popup(defineAsyncComponent(() => import('@/components/MkSigninDialog.vue')), { initialUsername }, {
			done: async (res: Misskey.entities.SigninFlowResponse & { finished: true }) => {
				if (expectedId !== undefined && res.id !== expectedId) return resolve(null);
				const user = await fetchAccount(res.i, res.id, true).catch(() => null);
				if (!user || user.id !== res.id) return resolve(null);
				await addAccount(host, user, res.i);
				resolve({ id: user.id, token: res.i, user });
			},
			cancelled: () => {
				resolve(null);
			},
		}, 'closed');
	});
}

export async function reauthenticateConsentAccount(account: ConsentAccount, token: string): Promise<string | null> {
	const current = cachedAccount?.id === account.id && cachedAccount.token === token ? cachedAccount : null;
	if (current && $i) {
		await requestTwoFactorSignin(token);
		return null;
	}
	const signedIn = await getAccountWithSigninDialog(account.username, account.id);
	if (!signedIn) return null;
	if (current) {
		Object.assign(current, signedIn.user, { token: signedIn.token });
		const saved = miLocalStorage.getItemAsJson('account');
		if (!saved || saved.id === current.id) saveCurrentAccount(signedIn.user, signedIn.token);
	}
	return signedIn.token;
}

export function getAccountWithSignupDialog(): Promise<{ id: string, token: string } | null> {
	return new Promise((resolve) => {
		popup(defineAsyncComponent(() => import('@/components/MkSignupDialog.vue')), {}, {
			done: async (res: Misskey.entities.SignupResponse) => {
				const user = JSON.parse(JSON.stringify(res));
				delete user.token;
				await addAccount(host, user, res.token);
				resolve({ id: res.id, token: res.token });
			},
			cancelled: () => {
				resolve(null);
			},
		}, 'closed');
	});
}
