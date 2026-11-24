/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { reactive } from 'vue';
import * as Misskey from 'misskey-js';
import { miLocalStorage } from '@/local-storage.js';

// TODO: 他のタブと永続化されたstateを同期

type AccountWithToken = Misskey.entities.MeDetailed & { token: string };

const accountData = miLocalStorage.getItem('account');

export function isConsentPage(): boolean {
	// These server-rendered markers remain after the page takes its transaction ID.
	return window.document.querySelector('meta[name="misskey:oauth:client-name"], meta[name="misskey:sso:service-name"]') !== null;
}

export const cachedAccount = accountData ? reactive(JSON.parse(accountData) as AccountWithToken) : null;

// Consent explicitly authenticates the selected account. Background requests must
// be able to boot and show sign-in even when the cached credential is restricted.
// TODO: 外部からはreadonlyに
export const $i = isConsentPage() ? null : cachedAccount;

export const iAmModerator = $i != null && ($i.isAdmin === true || $i.isModerator === true);
export const iAmAdmin = $i != null && $i.isAdmin;

export function ensureSignin() {
	if ($i == null) throw new Error('signin required');
	return $i;
}

export let notesCount = $i == null ? 0 : $i.notesCount;
export function incNotesCount() {
	notesCount++;
}

if (_DEV_) {
	(window as any).$i = $i;
}
