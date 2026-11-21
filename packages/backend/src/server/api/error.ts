/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

type E = { message: string, code: string, id: string, kind?: 'client' | 'server' | 'permission', httpStatusCode?: number };

export const enrollmentRequired = {
	message: 'Two-factor enrollment is required.',
	code: 'TWO_FACTOR_ENROLLMENT_REQUIRED',
	id: 'cc17c325-07bb-41ad-a970-f606b7c4bcf5',
	kind: 'permission',
	httpStatusCode: 403,
} as const;

export class ApiError extends Error {
	public message: string;
	public code: string;
	public id: string;
	public kind: string;
	public httpStatusCode?: number;
	public info?: any;

	constructor(err: E, info?: any | null | undefined) {
		super(err.message);
		this.message = err.message;
		this.code = err.code;
		this.id = err.id;
		this.kind = err.kind ?? 'client';
		this.httpStatusCode = err.httpStatusCode;
		this.info = info;
	}
}
