/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { entities } from 'misskey-js';
import { popup } from '@/os.js';

export async function enrollTwoFactor(enrollment: entities.TwoFactorEnrollment) {
	const { default: dialog } = await import('@/pages/settings/2fa.qrdialog.vue');
	return new Promise<Extract<entities.SigninFlowResponse, { finished: true }> | null>(resolve => {
		const { dispose } = popup(dialog, { enrollment, twoFactorData: enrollment }, {
			enrolled: resolve,
			closed: () => {
				resolve(null);
				dispose();
			},
		});
	});
}
