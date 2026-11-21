<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<MkModalWindow
	ref="dialog"
	:width="500"
	:height="600"
	@close="cancel"
	@closed="emit('closed')"
>
	<template #header>{{ i18n.ts.setupOf2fa }}</template>

	<div style="overflow-x: clip;">
		<Transition
			mode="out-in"
			:enterActiveClass="$style.transition_x_enterActive"
			:leaveActiveClass="$style.transition_x_leaveActive"
			:enterFromClass="$style.transition_x_enterFrom"
			:leaveToClass="$style.transition_x_leaveTo"
		>
			<template v-if="page === 0">
				<div style="height: 100cqh; overflow: auto; text-align: center;">
					<div class="_spacer" style="--MI_SPACER-min: 20px; --MI_SPACER-max: 28px;">
						<div class="_gaps">
							<MkInfo v-if="enrollment">{{ i18n.ts._2fa.enrollmentRequired }}</MkInfo>
							<MkInfo>
								<Mfm :text="i18n.tsx._2fa.detailedGuide({ link: `[${i18n.ts.here}](https://misskey-hub.net/docs/for-users/stepped-guides/how-to-enable-2fa/)`})"/>
							</MkInfo>

							<I18n :src="i18n.ts._2fa.step1" tag="div">
								<template #a>
									<a href="https://authy.com/" rel="nofollow noopener" target="_blank" class="_link">Authy</a>
								</template>
								<template #b>
									<a href="https://support.google.com/accounts/answer/1066447" rel="nofollow noopener" target="_blank" class="_link">Google Authenticator</a>
								</template>
							</I18n>
							<div>{{ i18n.ts._2fa.step2 }}</div>
							<div>
								<a :class="$style.qrRoot" :href="twoFactorData.url"><img :alt="i18n.ts._2fa.step2" :class="$style.qr" :src="twoFactorData.qr"></a>
								<!-- QRコード側にマージンが入っているので直下でOK -->
								<div><MkButton inline rounded type="routerLink" :to="twoFactorData.url" :linkBehavior="'browser'">{{ i18n.ts.launchApp }}</MkButton></div>
							</div>
							<MkKeyValue :copy="twoFactorData.url">
								<template #key>{{ i18n.ts._2fa.step2Uri }}</template>
								<template #value>{{ twoFactorData.url }}</template>
							</MkKeyValue>
						</div>
						<div class="_buttonsCenter" style="margin-top: 16px;">
							<MkButton rounded @click="cancel">{{ i18n.ts.cancel }}</MkButton>
							<MkButton primary rounded gradate @click="page++">{{ i18n.ts.continue }} <i class="ti ti-arrow-right"></i></MkButton>
						</div>
					</div>
				</div>
			</template>
			<template v-else-if="page === 1">
				<div style="height: 100cqh; overflow: auto;">
					<div class="_spacer" style="--MI_SPACER-min: 20px; --MI_SPACER-max: 28px;">
						<div class="_gaps">
							<label>
								{{ i18n.ts._2fa.step3Title }}
								<MkInput v-model="token" autocomplete="one-time-code" inputmode="numeric"></MkInput>
							</label>
							<div>{{ i18n.ts._2fa.step3 }}</div>
						</div>
						<div class="_buttonsCenter" style="margin-top: 16px;">
							<MkButton rounded :disabled="submitting" @click="page--"><i class="ti ti-arrow-left"></i> {{ i18n.ts.goBack }}</MkButton>
							<MkButton primary rounded gradate :disabled="submitting || !token" @click="tokenDone">{{ i18n.ts.continue }} <i class="ti ti-arrow-right"></i></MkButton>
						</div>
					</div>
				</div>
			</template>
			<template v-else-if="page === 2">
				<div style="height: 100cqh; overflow: auto;">
					<div class="_spacer" style="--MI_SPACER-min: 20px; --MI_SPACER-max: 28px;">
						<div class="_gaps">
							<div style="text-align: center;">{{ i18n.ts._2fa.setupCompleted }}🎉</div>
							<div style="text-align: center;">{{ i18n.ts._2fa.step4 }}</div>
							<div style="text-align: center; font-weight: bold;">{{ i18n.ts._2fa.checkBackupCodesBeforeCloseThisWizard }}</div>

							<MkFolder :defaultOpen="true">
								<template #icon><i class="ti ti-key"></i></template>
								<template #label>{{ i18n.ts._2fa.backupCodes }}</template>

								<div class="_gaps">
									<MkInfo warn>{{ i18n.ts._2fa.backupCodesDescription }}</MkInfo>
									<MkButton primary rounded gradate full @click="downloadBackupCodes"><i class="ti ti-download"></i> {{ i18n.ts.download }}</MkButton>

									<div v-for="(code, i) in backupCodes" :key="code" class="_gaps_s">
										<span style="text-align: center;">#{{ i + 1 }}. <code class="_monospace">{{ code }}</code></span>
									</div>
								</div>
							</MkFolder>
						</div>
						<div class="_buttonsCenter" style="margin-top: 16px;">
							<MkButton primary rounded gradate @click="allDone">{{ i18n.ts.done }}</MkButton>
						</div>
					</div>
				</div>
			</template>
		</Transition>
	</div>
</MkModalWindow>
</template>

<script lang="ts" setup>
import { hostname, port } from '@@/js/config';
import { useTemplateRef, ref } from 'vue';
import MkButton from '@/components/MkButton.vue';
import MkModalWindow from '@/components/MkModalWindow.vue';
import MkKeyValue from '@/components/MkKeyValue.vue';
import MkInput from '@/components/MkInput.vue';
import { i18n } from '@/i18n.js';
import * as os from '@/os.js';
import * as config from '@@/js/config.js';
import MkFolder from '@/components/MkFolder.vue';
import MkInfo from '@/components/MkInfo.vue';
import { confetti } from '@/utility/confetti.js';
import { $i } from '@/i.js';
import type { entities } from 'misskey-js';

const props = defineProps<{
	enrollment?: entities.TwoFactorEnrollment;
	twoFactorData: {
		qr: string;
		url: string;
	};
}>();

const emit = defineEmits<{
	(ev: 'closed'): void;
	(ev: 'enrolled', result: { finished: true; id: string; i: string }): void;
}>();

const dialog = useTemplateRef('dialog');
const page = ref(0);
const token = ref<string | null>(null);
const backupCodes = ref<string[]>();

const submitting = ref(false);
let credentials: { finished: true; id: string; i: string } | undefined;

function cancel() {
	if (submitting.value) return;
	if (page.value !== 2) dialog.value?.close();
	else allDone();
}

async function tokenDone() {
	if (token.value == null || submitting.value) return;
	submitting.value = true;
	try {
		const code = String(token.value).trim();
		if (props.enrollment) {
			const res = await os.apiWithDialog('signin-enroll-2fa', { ticket: props.enrollment.ticket, code }, null, {
				'b9655041-7b6f-4957-88bd-7e0666d2dc27': { text: i18n.ts._2fa.enrollmentCodeInvalid },
			});
			credentials = { finished: true, id: res.id, i: res.i };
			backupCodes.value = res.backupCodes;
		} else {
			backupCodes.value = (await os.apiWithDialog('i/2fa/done', { token: code })).backupCodes;
		}
	} catch {
		return; // apiWithDialog displays the error and the user can retry.
	} finally {
		submitting.value = false;
	}

	page.value = 2;

	confetti({
		duration: 1000 * 3,
	});
}

function downloadBackupCodes() {
	if (backupCodes.value !== undefined) {
		const txtBlob = new Blob([backupCodes.value.reduce((acc, code, i) => `${acc}#${i + 1}. ${code}\r\n`, `${config.hostname} 2FA Backup Codes\r\n\r\n`)], { type: 'text/plain' });
		const dummya = window.document.createElement('a');
		dummya.href = URL.createObjectURL(txtBlob);
		dummya.download = `${config.hostname}-${props.enrollment?.label ?? $i?.username ?? ''}@${hostname}` + (port !== '' ? `_${port}` : '') + '-2fa-backup-codes.txt';
		dummya.click();
	}
}

async function allDone() {
	const { canceled } = await os.confirm({
		type: 'warning',
		title: i18n.ts._2fa.backupCodesSavedConfirmTitle,
		text: i18n.ts._2fa.backupCodesSavedConfirmDescription,
		switchLabel: i18n.ts._2fa.backupCodesSavedConfirmChecked,
		okText: i18n.ts.gotIt,
		okWaitInitiate: 'switch',
		okWaitDuration: 5,
	});

	if (canceled) return;
	if (credentials) emit('enrolled', credentials);

	dialog.value?.close();
}
</script>

<style lang="scss" module>
.transition_x_enterActive,
.transition_x_leaveActive {
	transition: opacity 0.3s cubic-bezier(0,0,.35,1), transform 0.3s cubic-bezier(0,0,.35,1);
}
.transition_x_enterFrom {
	opacity: 0;
	transform: translateX(50px);
}
.transition_x_leaveTo {
	opacity: 0;
	transform: translateX(-50px);
}

.qrRoot {
	display: block;
	margin: 0 auto;
	width: 200px;
	max-width: 100%;
}

.qr {
	width: 100%;
}
</style>
