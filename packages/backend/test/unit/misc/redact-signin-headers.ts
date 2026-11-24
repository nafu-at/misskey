/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { redactSigninHeaders } from '@/misc/redact-signin-headers.js';

describe('redactSigninHeaders', () => {
	test('keeps diagnostic values, original casing, and unknown header names', () => {
		const headers = {
			'User-Agent': 'ExampleBrowser/1.0',
			'accept-language': ['ja', 'en'],
			'X-Build-Revision': 'beta-7',
			'X-Diagnostic': 'https://example.test/status?format=short',
		};
		expect(redactSigninHeaders(headers)).toEqual(headers);
	});

	test.each([
		['Cookie', 'theme=dark'],
		['pRoXy-AuThOrIzAtIoN', 'example'],
		['x_API_key', 'example'],
		['CF-Access-Jwt-Assertion', 'example'],
		['X-Request-Context', 'Bearer example'],
		['X-Request-Context', 'eyJhbGciOiJub25lIn0.e30.example'],
		['X-Request-Context', 'https://example.test/?X-Amz-Signature=example'],
		['X-Request-Context', 'https://user:example@example.test/'],
		['Referer', 'https://example.test/confirm/example'],
	])('masks the complete value of %s', (name, value) => {
		expect(redactSigninHeaders({ [name]: value })).toEqual({ [name]: '[REDACTED]' });
	});

	test('masks all values of a mixed header without changing the input or re-exposing old records', () => {
		const headers = { 'X-Diagnostic': ['ok', 'Basic example'], 'x-legacy': { token: 'example' } };
		const result = redactSigninHeaders(headers);
		expect(result).toEqual({ 'X-Diagnostic': '[REDACTED]', 'x-legacy': '[REDACTED]' });
		expect(redactSigninHeaders(result)).toEqual(result);
		expect(headers['X-Diagnostic']).toEqual(['ok', 'Basic example']);
	});
});
