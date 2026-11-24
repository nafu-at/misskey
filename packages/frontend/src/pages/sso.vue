<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div>
	<MkAnimBg style="position: fixed; top: 0;"/>
	<div :class="$style.formContainer">
		<div :class="$style.form">
			<MkAuthConfirm
				ref="authRoot"
				:name="name"
				:manualWaiting="submitting"
				@accept="onAccept"
				@deny="onDeny"
			/>
		</div>
	</div>
</div>
</template>

<script lang="ts" setup>
import { nextTick, onMounted, ref, useTemplateRef } from 'vue';
import MkAnimBg from '@/components/MkAnimBg.vue';
import { definePage } from '@/page.js';
import MkAuthConfirm from '@/components/MkAuthConfirm.vue';
import { cachedAccount } from '@/i.js';
import type { ConsentAccount } from '@/accounts.js';
import { reauthenticateConsentAccount } from '@/accounts.js';
import { generateClientTransactionId } from '@/utility/misskey-api.js';

const transactionIdMeta = window.document.querySelector<HTMLMetaElement>('meta[name="misskey:sso:transaction-id"]');
if (transactionIdMeta) {
	transactionIdMeta.remove();
}

const name = window.document.querySelector<HTMLMetaElement>('meta[name="misskey:sso:service-name"]')?.content;
const kind = window.document.querySelector<HTMLMetaElement>('meta[name="misskey:sso:kind"]')?.content;
const prompt = window.document.querySelector<HTMLMetaElement>('meta[name="misskey:sso:prompt"]')?.content;

const authRoot = useTemplateRef('authRoot');
const submitting = ref(false);

async function onAccept(token: string, account: ConsentAccount) {
	if (submitting.value) return;
	submitting.value = true;
	try {
		await authorize(token, account, true);
	} finally {
		submitting.value = false;
	}
}

async function authorize(token: string, account: ConsentAccount, retry: boolean): Promise<void> {
	const result = await window.fetch(`/sso/${kind}/authorize`, {
		method: 'POST',
		credentials: 'include',
		headers: {
			'Content-Type': 'application/json',
			'X-Client-Transaction-Id': generateClientTransactionId('sso'),
		},
		body: JSON.stringify({
			transaction_id: transactionIdMeta?.content,
			login_token: token,
		}),
	}).then(async res => {
		const body = await res.json();
		if (res.ok) return body;
		if (retry && (body.error?.code === 'TWO_FACTOR_ENROLLMENT_REQUIRED' || body.error?.code === 'INVALID_LOGIN_TOKEN')) {
			const credential = await reauthenticateConsentAccount(account, token);
			if (credential) return authorize(credential, account, false);
			authRoot.value?.showUI('accountSelect');
			return;
		}
		authRoot.value?.showUI('failed');
	}).catch(() => {
		authRoot.value?.showUI('failed');
	});

	if (!result) return;
	authRoot.value?.showUI('success');

	if (result.binding === 'post') {
		const form = window.document.createElement('form');
		form.style.display = 'none';
		form.action = result.action;
		form.method = 'post';
		form.acceptCharset = 'utf-8';

		for (const [name, value] of Object.entries(result.context)) {
			const input = window.document.createElement('input');
			input.type = 'hidden';
			input.name = name;
			input.value = value as string;
			form.appendChild(input);
		}

		nextTick(() => {
			window.document.body.appendChild(form);
			form.submit();
		});
	} else {
		window.location.href = result.action;
	}
}

function onDeny(token: string) {
	authRoot.value?.showUI('denied');
}

onMounted(() => {
	nextTick(() => {
		if (cachedAccount && prompt === 'none') {
			onAccept(cachedAccount.token, cachedAccount);
		}
	});
});
definePage(() => ({
	title: 'Single Sign-On',
	icon: 'ti ti-apps',
}));
</script>

<style lang="scss" module>
.formContainer {
	min-height: 100svh;
	padding: 32px 32px calc(env(safe-area-inset-bottom, 0px) + 32px) 32px;
	box-sizing: border-box;
	display: grid;
	place-content: center;
}

.form {
	position: relative;
	z-index: 10;
	border-radius: var(--MI-radius);
	background-color: var(--MI_THEME-panel);
	box-shadow: 0 8px 16px rgba(0, 0, 0, 0.1);
	overflow: clip;
	max-width: 500px;
	width: calc(100vw - 64px);
	height: min(65svh, calc(100svh - calc(env(safe-area-inset-bottom, 0px) + 64px)));
	overflow-y: scroll;
}
</style>
