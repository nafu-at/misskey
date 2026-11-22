/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Address4, Address6 } from 'ip-address';

function getAddressPrefix(ip: string): string {
	const parsed = ip.includes(':') ? new Address6(ip) : new Address4(ip);
	// Keep embedded dotted IPv4 addresses in the same bucket as plain IPv4.
	const host = parsed instanceof Address6 ? parsed.address4 ?? parsed : parsed;
	return host.mask(host instanceof Address4 ? 32 : 64);
}

export function getIpHash(ip: string): string {
	let prefix: string;
	try {
		prefix = getAddressPrefix(ip);
	} catch {
		// Some proxies include a port in the client address.
		prefix = getAddressPrefix(ip.replace(/:[0-9]+$/, ''));
	}
	return 'ip-' + BigInt('0b' + prefix).toString(36);
}
