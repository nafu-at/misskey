/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { defaultLogRedactor } from '@/logging/LogNormalizer.js';

// In addition to the normal log redactor, cover IdP/proxy credentials and
// fields that may carry an entire URL, certificate or authentication context.
const credentialName = /session|csrf|xsrf|jwt|assertion|signature|authentication|passcode|saml(?:request|response)|(?:^|[-_])(?:auth|oauth2?|dpop|key|cert|certificate|otp|totp|2fa|mfa|ticket)(?:$|[-_])|^x-misskey-i$/i;
const sensitiveContext = /^(?:referer|referrer|baggage|tracestate|sec-websocket-protocol|:path)$|[-_](?:original|rewrite|forwarded)[-_](?:url|uri)$/i;
const authScheme = /(?:^|[\s,])(?:basic|bearer|digest|negotiate|ntlm|dpop|oauth|aws4-hmac-sha256)\s+\S/i;
const compactJwt = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+/;
const urlUserInfo = /:\/\/[^\s/?#@]+@/;

function isCredentialName(name: string): boolean {
	return defaultLogRedactor([], name) || credentialName.test(name);
}

function isSensitiveValue(value: string): boolean {
	if (authScheme.test(value) || compactJwt.test(value) || urlUserInfo.test(value) || value.includes('PRIVATE KEY-----')) return true;
	for (const [, key] of value.matchAll(/(?:^|[?&#;,\s])([\w.-]+)\s*=/g)) {
		if (isCredentialName(key) || /^(?:code|sig)$/i.test(key)) return true;
	}
	return false;
}

/** Keep diagnostic headers and their original names, including on historical rows. */
export function redactSigninHeaders(headers: Record<string, unknown>): Record<string, string | string[]> {
	const result: Record<string, string | string[]> = Object.create(null);
	for (const [name, value] of Object.entries(headers)) {
		if (value === undefined) continue;
		if (isCredentialName(name) || sensitiveContext.test(name)) {
			result[name] = '[REDACTED]';
		} else if (typeof value === 'string' && !isSensitiveValue(value)) {
			result[name] = value;
		} else if (Array.isArray(value) && value.every(item => typeof item === 'string' && !isSensitiveValue(item))) {
			result[name] = [...value];
		} else {
			result[name] = '[REDACTED]';
		}
	}
	return result;
}
