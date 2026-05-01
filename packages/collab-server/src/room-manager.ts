/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Room manager.
 *
 * Each room owns:
 *   - one in-memory Y.Doc that all peers in the room sync against
 *   - a set of WebSocket connections
 *   - an Awareness instance forwarded over the same connections
 *
 * Updates are persisted via the supplied `Persistence`. Compaction kicks
 * in every `compactEvery` updates per spec §12.2.
 */

import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as Y from 'yjs';
import type { WebSocket } from 'ws';
import type { Persistence } from './persistence.js';
import type { Principal } from './auth.js';
import { canWrite } from './auth.js';
import {
  noopAuditSink,
  shortHash,
  type AuditOpType,
  type AuditSink,
} from './audit-log.js';
import { createRateLimiter, type RateLimitOptions, type RateLimiter } from './rate-limit.js';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

export interface RoomOptions {
  persistence: Persistence;
  /** Compact the persisted log every N updates (default 1000). */
  compactEvery?: number;
  /** Idle timeout before a room is unloaded (default 60s). */
  idleUnloadMs?: number;
  /** Audit sink for connect/update/awareness events (default = no-op). */
  auditSink?: AuditSink;
  /**
   * Per-peer rate-limit knobs. Applied per connection. Service accounts
   * (e.g. MCP agents) typically get a tighter budget than humans.
   */
  rateLimit?: RateLimitOptions | ((principal: Principal) => RateLimitOptions);
}

export interface PeerConnection {
  ws: WebSocket;
  principal: Principal;
  /** Subscribed clientIDs that this peer's awareness has reported (for cleanup). */
  awarenessClients: Set<number>;
  /** Per-connection rate limiter. */
  limiter?: RateLimiter;
}

export class Room {
  readonly id: string;
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  private readonly conns = new Set<PeerConnection>();
  private readonly persistence: Persistence;
  private updatesSinceCompact = 0;
  private readonly compactEvery: number;
  private readonly auditSink: AuditSink;
  private readonly rateLimitFor: (principal: Principal) => RateLimitOptions;
  private destroyed = false;

  constructor(id: string, opts: RoomOptions) {
    this.id = id;
    this.doc = new Y.Doc();
    this.awareness = new Awareness(this.doc);
    this.persistence = opts.persistence;
    this.compactEvery = opts.compactEvery ?? 1000;
    this.auditSink = opts.auditSink ?? noopAuditSink;
    const rl = opts.rateLimit;
    this.rateLimitFor = typeof rl === 'function' ? rl : () => rl ?? {};

    this.doc.on('update', this.onDocUpdate);
    this.awareness.on('update', this.onAwarenessUpdate);
  }

  /**
   * Append an audit-log entry for this room.
   * Public so the http upgrade handler can log connect/disconnect.
   */
  audit(
    principal: Principal,
    opType: AuditOpType,
    opHash: string,
    detail?: Record<string, unknown>,
  ): void {
    void Promise.resolve(
      this.auditSink.append({
        timestamp: new Date().toISOString(),
        userId: principal.userId,
        role: principal.role,
        roomId: this.id,
        opType,
        opHash,
        detail,
      }),
    ).catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[collab-server] audit append error:`, err);
    });
  }

  async loadFromDisk(): Promise<void> {
    const saved = await this.persistence.load(this.id);
    if (saved && saved.byteLength > 0) {
      Y.applyUpdate(this.doc, saved, 'load-from-disk');
    }
  }

  /** Number of currently connected peers. */
  get peerCount(): number {
    return this.conns.size;
  }

  addConnection(conn: PeerConnection): void {
    if (!conn.limiter) {
      conn.limiter = createRateLimiter(this.rateLimitFor(conn.principal));
    }
    this.conns.add(conn);
    this.audit(conn.principal, 'connect', '');
    // Step 1 of the y-protocols sync handshake: send our state vector.
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(enc, this.doc);
    safeSend(conn.ws, encoding.toUint8Array(enc));
    // Send our current awareness snapshot.
    const states = this.awareness.getStates();
    if (states.size > 0) {
      const aenc = encoding.createEncoder();
      encoding.writeVarUint(aenc, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        aenc,
        encodeAwarenessUpdate(this.awareness, Array.from(states.keys())),
      );
      safeSend(conn.ws, encoding.toUint8Array(aenc));
    }
  }

  removeConnection(conn: PeerConnection): void {
    this.conns.delete(conn);
    if (conn.awarenessClients.size > 0) {
      removeAwarenessStates(this.awareness, Array.from(conn.awarenessClients), 'connection-closed');
    }
    this.audit(conn.principal, 'disconnect', '');
  }

  /** Receive a binary message from a peer and dispatch it. */
  handleMessage(conn: PeerConnection, msg: Uint8Array): void {
    if (this.destroyed) return;
    const decoder = decoding.createDecoder(msg);
    const messageType = decoding.readVarUint(decoder);
    switch (messageType) {
      case MESSAGE_SYNC: {
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MESSAGE_SYNC);
        const replyType = syncProtocol.readSyncMessage(decoder, enc, this.doc, conn);
        // Updates require write capability + a fresh rate-limit token.
        if (replyType === syncProtocol.messageYjsUpdate) {
          if (!canWrite(conn.principal)) {
            this.audit(conn.principal, 'reject', shortHash(msg), { reason: 'role' });
            return;
          }
          if (conn.limiter && !conn.limiter.tryConsume(1)) {
            this.audit(conn.principal, 'reject', shortHash(msg), { reason: 'rate-limit' });
            return;
          }
          this.audit(conn.principal, 'update', shortHash(msg), { bytes: msg.byteLength });
        } else if (replyType === syncProtocol.messageYjsSyncStep1) {
          this.audit(conn.principal, 'sync-step1', '');
        } else if (replyType === syncProtocol.messageYjsSyncStep2) {
          this.audit(conn.principal, 'sync-step2', '');
        }
        if (encoding.length(enc) > 1) {
          safeSend(conn.ws, encoding.toUint8Array(enc));
        }
        break;
      }
      case MESSAGE_AWARENESS: {
        const update = decoding.readVarUint8Array(decoder);
        applyAwarenessUpdate(this.awareness, update, conn);
        this.audit(conn.principal, 'awareness', shortHash(update));
        break;
      }
      default:
        // Unknown frame; ignore.
        break;
    }
  }

  /** Forward Y updates to every other connected peer and persist. */
  private onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === 'load-from-disk') return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_SYNC);
    syncProtocol.writeUpdate(enc, update);
    const message = encoding.toUint8Array(enc);
    for (const conn of this.conns) {
      if (conn === origin) continue;
      safeSend(conn.ws, message);
    }
    void this.persistAndMaybeCompact(update);
  };

  private async persistAndMaybeCompact(update: Uint8Array): Promise<void> {
    try {
      await this.persistence.append(this.id, update);
      this.updatesSinceCompact++;
      if (this.updatesSinceCompact >= this.compactEvery) {
        const merged = Y.encodeStateAsUpdate(this.doc);
        await this.persistence.compact(this.id, merged);
        this.updatesSinceCompact = 0;
      }
    } catch (err) {
      // Persistence failures are logged but never block sync — the
      // in-memory state is still consistent across peers, and the next
      // successful append/compact catches up.
      // eslint-disable-next-line no-console
      console.error(`[collab-server] persistence error for room ${this.id}:`, err);
    }
  }

  /**
   * Forward an awareness update to every other peer. Tracks which client
   * IDs the connection contributed so we can clean up on disconnect.
   */
  private onAwarenessUpdate = (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    const all = [...changes.added, ...changes.updated, ...changes.removed];
    if (origin && (origin as PeerConnection).ws) {
      const conn = origin as PeerConnection;
      for (const client of changes.added) conn.awarenessClients.add(client);
      for (const client of changes.removed) conn.awarenessClients.delete(client);
    }
    if (all.length === 0) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(enc, encodeAwarenessUpdate(this.awareness, all));
    const message = encoding.toUint8Array(enc);
    for (const conn of this.conns) {
      if (conn === origin) continue;
      safeSend(conn.ws, message);
    }
  };

  async destroy(): Promise<void> {
    this.destroyed = true;
    for (const conn of this.conns) {
      try { conn.ws.close(); } catch { /* socket may already be torn down */ }
    }
    this.conns.clear();
    this.doc.off('update', this.onDocUpdate);
    this.awareness.off('update', this.onAwarenessUpdate);
    // Final compaction so the next load picks up the freshest state.
    try {
      await this.persistence.compact(this.id, Y.encodeStateAsUpdate(this.doc));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[collab-server] compact-on-destroy error for ${this.id}:`, err);
    }
    this.awareness.destroy();
    this.doc.destroy();
  }
}

export interface RoomManagerOptions extends RoomOptions {
  /** Soft cap on simultaneous rooms (default 1024). */
  maxRooms?: number;
}

export class RoomManager {
  private readonly rooms = new Map<string, Promise<Room>>();
  private readonly options: RoomManagerOptions;

  constructor(options: RoomManagerOptions) {
    this.options = options;
  }

  async getOrCreate(roomId: string): Promise<Room> {
    let pending = this.rooms.get(roomId);
    if (pending) return pending;
    const max = this.options.maxRooms ?? 1024;
    if (this.rooms.size >= max) {
      throw new Error(`@ifc-lite/collab-server: room limit (${max}) reached`);
    }
    pending = (async () => {
      const room = new Room(roomId, this.options);
      await room.loadFromDisk();
      return room;
    })();
    this.rooms.set(roomId, pending);
    return pending;
  }

  list(): string[] {
    return Array.from(this.rooms.keys());
  }

  async unload(roomId: string): Promise<void> {
    const pending = this.rooms.get(roomId);
    if (!pending) return;
    this.rooms.delete(roomId);
    const room = await pending;
    await room.destroy();
  }

  async unloadAll(): Promise<void> {
    await Promise.all(Array.from(this.rooms.keys()).map((id) => this.unload(id)));
  }
}

function safeSend(ws: WebSocket, data: Uint8Array): void {
  try {
    if (ws.readyState === ws.OPEN) ws.send(data);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[collab-server] ws send error:', err);
  }
}
