/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { EventEmitter } from 'events';
import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import * as WebSocket from 'ws';
import { DI } from '@/di-symbols.js';
import type { MiAccessToken } from '@/models/_.js';
import { bindThis } from '@/decorators.js';
import { MiLocalUser } from '@/models/User.js';
import { RoleService } from '@/core/RoleService.js';
import { AccessTokenService } from '@/core/AccessTokenService.js';
import { UserService } from '@/core/UserService.js';
import { AuthenticateService, AuthenticationError } from './AuthenticateService.js';
import { ApiLoggerService } from './ApiLoggerService.js';
import MainStreamConnection, { ConnectionRequest } from './stream/Connection.js';
import type * as http from 'node:http';
import { ContextIdFactory, ModuleRef } from '@nestjs/core';

@Injectable()
export class StreamingApiServerService {
	#wss: WebSocket.WebSocketServer;
	#connections = new Map<WebSocket.WebSocket, { lastActive: number; userId?: string; accessTokenId?: string }>();
	#cleanConnectionsIntervalId: NodeJS.Timeout | null = null;
	#checkingAccessTokens = false;

	constructor(
		@Inject(DI.redisForSub)
		private redisForSub: Redis.Redis,

		private moduleRef: ModuleRef,
		private authenticateService: AuthenticateService,
		private accessTokenService: AccessTokenService,
		private apiLoggerService: ApiLoggerService,
		private usersService: UserService,
		private roleService: RoleService,
	) {
	}

	@bindThis
	public attach(server: http.Server): void {
		this.#wss = new WebSocket.WebSocketServer({
			noServer: true,
		});

		server.on('upgrade', async (request, socket, head) => {
			if (request.url == null) {
				socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
				socket.destroy();
				return;
			}

			const q = new URL(request.url, `http://${request.headers.host}`).searchParams;

			let user: MiLocalUser | null = null;
			let app: MiAccessToken | null = null;

			// https://datatracker.ietf.org/doc/html/rfc6750.html#section-2.1
			// Note that the standard WHATWG WebSocket API does not support setting any headers,
			// but non-browser apps may still be able to set it.
			const token = request.headers.authorization?.startsWith('Bearer ')
				? request.headers.authorization.slice(7)
				: q.get('i');

			try {
				[user, app] = await this.authenticateService.authenticate(token);

				if (user && await this.roleService.requiresTwoFactorEnrollment(user.id)) {
					socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
					return;
				}
				if (app !== null && !app.permission.some(p => p === 'read:account')) {
					throw new AuthenticationError('Your app does not have necessary permissions to use websocket API.');
				}
			} catch (e) {
				if (e instanceof AuthenticationError) {
					socket.write([
						'HTTP/1.1 401 Unauthorized',
						'WWW-Authenticate: Bearer realm="Misskey", error="invalid_token", error_description="Failed to authenticate"',
					].join('\r\n') + '\r\n\r\n');
				} else {
					socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
				}
				socket.destroy();
				return;
			}

			if (user?.isSuspended) {
				socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
				socket.destroy();
				return;
			}

			const contextId = ContextIdFactory.create();
			this.moduleRef.registerRequestByContextId<ConnectionRequest>({
				user,
				token: app,
			}, contextId);
			const stream = await this.moduleRef.create(MainStreamConnection, contextId);

			await stream.init();

			this.#wss.handleUpgrade(request, socket, head, (ws) => {
				this.#wss.emit('connection', ws, request, {
					stream, user, token,
				});
			});
		});

		const globalEv = new EventEmitter();

		this.redisForSub.on('message', (_: string, data: string) => {
			const parsed = JSON.parse(data);
			if (parsed.channel === 'internal') {
				const { type, body } = parsed.message;
				if (type === 'userTokenRegenerated') {
					for (const [ws, state] of this.#connections) {
						if (state.userId === body.id) ws.terminate();
					}
				} else if (type === 'accessTokenRevoked') {
					for (const [ws, state] of this.#connections) {
						if (state.accessTokenId === body.id) ws.terminate();
					}
				} else if (['userRoleAssigned', 'userRoleUnassigned', 'userInlinePoliciesUpdated', 'localUserUpdated'].includes(type)) {
					this.recheckEnrollment(body.userId ?? body.id);
				} else if (['roleCreated', 'roleUpdated', 'roleDeleted', 'policiesUpdated'].includes(type)) {
					this.recheckEnrollment();
				}
			}
			globalEv.emit('message', parsed);
		});

		this.#wss.on('connection', async (connection: WebSocket.WebSocket, request: http.IncomingMessage, ctx: {
			stream: MainStreamConnection,
			user: MiLocalUser | null;
			token: string | null
		}) => {
			const { stream, user, token } = ctx;
			connection.pause();

			const ev = new EventEmitter();

			function onRedisMessage(data: any): void {
				ev.emit(data.channel, data.message);
			}

			const state = { lastActive: Date.now(), userId: user?.id, accessTokenId: stream.token?.id };
			this.#connections.set(connection, state);

			const userUpdateIntervalId = user ? setInterval(() => {
				this.usersService.updateLastActiveDate(user);
			}, 1000 * 60 * 5) : undefined;

			connection.once('close', () => {
				ev.removeAllListeners();
				stream.dispose();
				globalEv.off('message', onRedisMessage);
				this.#connections.delete(connection);
				if (userUpdateIntervalId) clearInterval(userUpdateIntervalId);
			});

			// Track the socket before checking credentials again. Revocation during
			// initialization must win before the connection can receive any events.
			if (user) {
				try {
					if (state.accessTokenId) {
						const active = await this.accessTokenService.findActiveIds([state.accessTokenId]);
						if (!active.has(state.accessTokenId)) {
							connection.terminate();
							return;
						}
					} else {
						const [current] = await this.authenticateService.authenticate(token);
						if (current?.id !== user.id) {
							connection.terminate();
							return;
						}
					}
					if (await this.roleService.requiresTwoFactorEnrollment(user.id)) {
						connection.close(1008, 'TWO_FACTOR_ENROLLMENT_REQUIRED');
						return;
					}
				} catch {
					connection.terminate();
					return;
				}
			}
			if (connection.readyState !== connection.OPEN) return;
			globalEv.on('message', onRedisMessage);
			await stream.listen(ev, connection);
			connection.resume();

			if (user) {
				this.usersService.updateLastActiveDate(user);
			}

			connection.on('pong', () => {
				state.lastActive = Date.now();
			});
		});

		// 一定期間通信が無いコネクションは実際には切断されている可能性があるため定期的にterminateする
		this.#cleanConnectionsIntervalId = setInterval(() => {
			const now = Date.now();
			this.recheckEnrollment();
			void this.recheckAccessTokens();
			for (const [connection, { lastActive }] of this.#connections.entries()) {
				if (now - lastActive > 1000 * 60 * 2) {
					connection.terminate();
					this.#connections.delete(connection);
				} else {
					connection.ping();
				}
			}
		}, 1000 * 60);
	}

	private async recheckAccessTokens(): Promise<void> {
		if (this.#checkingAccessTokens) return;
		const socketsByToken = new Map<string, WebSocket.WebSocket[]>();
		for (const [socket, { accessTokenId }] of this.#connections) {
			if (!accessTokenId) continue;
			const sockets = socketsByToken.get(accessTokenId);
			if (sockets) sockets.push(socket);
			else socketsByToken.set(accessTokenId, [socket]);
		}
		if (socketsByToken.size === 0) return;

		this.#checkingAccessTokens = true;
		try {
			// Redis Pub/Sub does not replay revocations missed during a disconnect.
			const ids = [...socketsByToken.keys()];
			const batchSize = 500;
			for (let i = 0; i < ids.length; i += batchSize) {
				const batch = ids.slice(i, i + batchSize);
				const active = await this.accessTokenService.findActiveIds(batch);
				for (const id of batch) {
					if (!active.has(id)) {
						for (const socket of socketsByToken.get(id)!) socket.terminate();
					}
				}
			}
		} catch (err) {
			this.apiLoggerService.logger.warn('Failed to check streaming access tokens', { error: err });
		} finally {
			this.#checkingAccessTokens = false;
		}
	}

	private recheckEnrollment(userId?: string): void {
		const checks = new Map<string, Promise<boolean>>();
		for (const [ws, state] of this.#connections) {
			if (!state.userId || (userId && userId !== state.userId)) continue;
			let check = checks.get(state.userId);
			if (!check) {
				check = this.roleService.requiresTwoFactorEnrollment(state.userId);
				checks.set(state.userId, check);
			}
			void check.then(required => {
				if (required) ws.close(1008, 'TWO_FACTOR_ENROLLMENT_REQUIRED');
			}, () => ws.terminate());
		}
	}

	@bindThis
	public detach(): Promise<void> {
		if (this.#cleanConnectionsIntervalId) {
			clearInterval(this.#cleanConnectionsIntervalId);
			this.#cleanConnectionsIntervalId = null;
		}
		return new Promise((resolve) => {
			this.#wss.close(() => resolve());
		});
	}
}
