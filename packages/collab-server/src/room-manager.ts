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

// Inner sync-message subtypes (mirror y-protocols/sync constants) used for
// the cheap pre-verify frame peek. Kept local so the peek never has to call
// the full readSyncMessage (which applies payloads to the doc as a side
// effect). Step2 (1) and Update (2) carry a doc-mutating payload.
const SYNC_STEP2 = syncProtocol.messageYjsSyncStep2;
const SYNC_UPDATE = syncProtocol.messageYjsUpdate;

/**
 * Hard ceiling on a single sync write-frame, enforced before the
 * path-lock verifier parses it through a throwaway Y.Doc. Bounds the
 * O(update_size) allocation an attacker can force per message. 8 MB is
 * far above any legitimate incremental Y update; whole-doc state lands
 * via persistence, not a single wire frame.
 */
const MAX_SYNC_PAYLOAD_BYTES = 8 * 1024 * 1024;

/**
 * Hard ceiling on a single awareness frame. Presence/cursor payloads are
 * tiny; anything larger is abuse. Caps the decode + broadcast amplification
 * an unmetered awareness flood could drive.
 */
const MAX_AWARENESS_BYTES = 128 * 1024;

export interface VerifyDecision {
  ok: boolean;
  /** Audit-friendly reason string when ok=false. */
  reason?: string;
}

export type VerifyMessageFn = (msg: Uint8Array, conn: PeerConnection) => VerifyDecision;

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
  /**
   * Optional per-message verifier. For plain sync write-frames the cheap
   * role + rate-limit + payload-size gate (preCheckWriteFrame) runs FIRST,
   * so a non-writer / rate-limited / oversized frame is rejected before the
   * verifier parses it (avoids Y.Doc-parse amplification). Signed-envelope
   * frames (e.g. the anti-replay protector's `0xff`-tagged frames) aren't
   * recognised as sync write-frames, so the verifier still runs first for
   * them and sees every signed frame. Returning `{ ok: false }` audits as
   * `reject` with `reason`.
   */
  verifyMessage?: VerifyMessageFn;
  /** Internal: metric counters injected by the manager. */
  counters?: { update?: () => void; reject?: (reason: string) => void };
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
  private readonly verifyMessage?: VerifyMessageFn;
  private counters: { update?: () => void; reject?: (reason: string) => void };
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
    this.verifyMessage = opts.verifyMessage;
    this.counters = opts.counters ?? {};

    this.doc.on('update', this.onDocUpdate);
    this.awareness.on('update', this.onAwarenessUpdate);
  }

  setCounters(counters: { update?: () => void; reject?: (reason: string) => void }): void {
    this.counters = counters;
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
    // Gate write-frames on role + rate-limit + payload size BEFORE the
    // (potentially expensive) verifyMessage. The path-lock verifier runs
    // a throwaway Y.applyUpdate on the payload, so a non-writer or a
    // rate-limited peer must be rejected before any parse — otherwise a
    // 'viewer' could force unbounded full-Y.Doc parses by flooding
    // write-tagged frames (asymmetric CPU/GC DoS). Cheap peeks only here.
    if (!this.preCheckWriteFrame(conn, msg)) return;
    if (this.verifyMessage) {
      const decision = this.verifyMessage(msg, conn);
      if (!decision.ok) {
        const reason = decision.reason ?? 'verify-failed';
        this.audit(conn.principal, 'reject', shortHash(msg), { reason });
        this.counters.reject?.(reason);
        return;
      }
    }
    try {
      this.dispatchMessage(conn, msg);
    } catch {
      // Malformed/truncated frame from a peer. lib0 decoding throws
      // (errorUnexpectedEndOfArray / RangeError) on short or oversized
      // varint frames; never let that reach the ws listener as an
      // uncaughtException — it would kill the whole process.
      this.audit(conn.principal, 'reject', shortHash(msg), { reason: 'malformed' });
      this.counters.reject?.('malformed');
    }
  }

  /**
   * Cheap pre-verify guard. Peeks the outer + inner frame type without
   * applying anything to the doc and, for sync write-frames, enforces the
   * role gate, the per-connection rate limiter, and a payload-size bound.
   * Returns `false` (already audited + counted) when the frame is rejected;
   * `true` when it is safe to continue to verifyMessage / dispatch.
   *
   * A frame whose header can't be peeked is waved through — the downstream
   * decode in dispatchMessage owns the `malformed` audit so we don't
   * double-count it here.
   */
  private preCheckWriteFrame(conn: PeerConnection, msg: Uint8Array): boolean {
    let outerType: number;
    let subtype: number;
    try {
      const decoder = decoding.createDecoder(msg);
      outerType = decoding.readVarUint(decoder);
      if (outerType !== MESSAGE_SYNC) return true;
      subtype = decoding.peekVarUint(decoder);
    } catch {
      // Unreadable header: let dispatchMessage produce the malformed audit.
      return true;
    }
    const isWriteFrame = subtype === SYNC_UPDATE || subtype === SYNC_STEP2;
    if (!isWriteFrame) return true;
    if (!canWrite(conn.principal)) {
      this.audit(conn.principal, 'reject', shortHash(msg), { reason: 'role' });
      this.counters.reject?.('role');
      return false;
    }
    if (conn.limiter && !conn.limiter.tryConsume(1)) {
      this.audit(conn.principal, 'reject', shortHash(msg), { reason: 'rate-limit' });
      this.counters.reject?.('rate-limit');
      return false;
    }
    if (msg.byteLength > MAX_SYNC_PAYLOAD_BYTES) {
      this.audit(conn.principal, 'reject', shortHash(msg), { reason: 'sync-size' });
      this.counters.reject?.('sync-size');
      return false;
    }
    return true;
  }

  /** Decode + dispatch a verified frame. May throw on malformed input. */
  private dispatchMessage(conn: PeerConnection, msg: Uint8Array): void {
    const decoder = decoding.createDecoder(msg);
    const messageType = decoding.readVarUint(decoder);
    switch (messageType) {
      case MESSAGE_SYNC: {
        // The capability/rate-limit/size gate for write-frames already ran
        // in preCheckWriteFrame (BEFORE verifyMessage), so a viewer can't
        // mutate state and a rate-limited peer can't force a parse. Here we
        // only apply the (now-authorized) frame to the doc.
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MESSAGE_SYNC);
        const replyType = syncProtocol.readSyncMessage(decoder, enc, this.doc, conn);
        if (replyType === syncProtocol.messageYjsUpdate) {
          this.audit(conn.principal, 'update', shortHash(msg), { bytes: msg.byteLength });
          this.counters.update?.();
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
        // Awareness frames are decoded, applied to the shared Awareness, and
        // re-broadcast to every peer — an unmetered amplification channel
        // that even non-writers (viewer/commenter) can drive. Bound the size
        // and charge the per-connection budget before applying, mirroring the
        // sync write path.
        if (update.byteLength > MAX_AWARENESS_BYTES) {
          this.audit(conn.principal, 'reject', shortHash(update), { reason: 'awareness-size' });
          this.counters.reject?.('awareness-size');
          return;
        }
        if (conn.limiter && !conn.limiter.tryConsume(1)) {
          this.audit(conn.principal, 'reject', shortHash(update), { reason: 'rate-limit' });
          this.counters.reject?.('rate-limit');
          return;
        }
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

export interface RoomCounters {
  update?: () => void;
  reject?: (reason: string) => void;
}

export class RoomManager {
  private readonly rooms = new Map<string, Promise<Room>>();
  /** Wall-clock ms when a room last had >0 peers, or 0 if never observed. */
  private readonly lastActiveAt = new Map<string, number>();
  private readonly options: RoomManagerOptions;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private counters: RoomCounters = {};

  constructor(options: RoomManagerOptions) {
    this.options = options;
    if (options.idleUnloadMs && options.idleUnloadMs > 0) {
      // Sweep at half the idle window so eviction granularity is reasonable.
      const sweepMs = Math.max(1_000, Math.floor(options.idleUnloadMs / 2));
      this.idleTimer = setInterval(() => {
        void this.sweepIdle();
      }, sweepMs);
      // Don't keep the Node event loop alive solely for this timer.
      this.idleTimer.unref?.();
    }
  }

  async getOrCreate(roomId: string): Promise<Room> {
    let pending = this.rooms.get(roomId);
    if (pending) {
      this.lastActiveAt.set(roomId, Date.now());
      return pending;
    }
    const max = this.options.maxRooms ?? 1024;
    if (this.rooms.size >= max) {
      throw new Error(`@ifc-lite/collab-server: room limit (${max}) reached`);
    }
    const counters = this.counters;
    const verifyMessage = this.options.verifyMessage;
    pending = (async () => {
      const room = new Room(roomId, { ...this.options, counters, verifyMessage });
      await room.loadFromDisk();
      return room;
    })();
    // Evict the cached promise if initialization fails so a transient load
    // error or a corrupt persisted log does not permanently brick the room
    // (and does not keep occupying a maxRooms slot / break sweepIdle's await).
    pending.catch((err) => {
      // Surface the failure: a broken loadFromDisk() (corrupt persisted log or
      // a transient init error) must stay diagnosable, not vanish silently.
      // eslint-disable-next-line no-console
      console.error(`[collab-server] room load failed (room=${roomId}):`, err);
      // Only delete if it is still the same poisoned promise (avoid clobbering
      // a successful re-create that may have replaced it concurrently).
      if (this.rooms.get(roomId) === pending) {
        this.rooms.delete(roomId);
        this.lastActiveAt.delete(roomId);
      }
    });
    this.rooms.set(roomId, pending);
    this.lastActiveAt.set(roomId, Date.now());
    return pending;
  }

  /**
   * Inject counters used by `Room.handleMessage` to bump metric values.
   * The manager forwards them to every newly-loaded room.
   */
  setCounters(counters: RoomCounters): void {
    this.counters = counters;
    // Apply to already-loaded rooms via their internal hook.
    for (const pending of this.rooms.values()) {
      void pending.then((room) => room.setCounters(counters));
    }
  }

  list(): string[] {
    return Array.from(this.rooms.keys());
  }

  /** Snapshot of `(roomId, peerCount)` for diagnostics / tests. */
  async stats(): Promise<Array<{ roomId: string; peerCount: number; idleMs: number }>> {
    const out: Array<{ roomId: string; peerCount: number; idleMs: number }> = [];
    const now = Date.now();
    for (const [roomId, pending] of this.rooms) {
      let room: Room;
      try {
        room = await pending;
      } catch {
        // A poisoned (rejected) load promise is evicted by getOrCreate's
        // own .catch handler; skip it here so one bad room can't abort stats.
        continue;
      }
      out.push({
        roomId,
        peerCount: room.peerCount,
        idleMs: now - (this.lastActiveAt.get(roomId) ?? now),
      });
    }
    return out;
  }

  async unload(roomId: string): Promise<void> {
    const pending = this.rooms.get(roomId);
    if (!pending) return;
    this.rooms.delete(roomId);
    this.lastActiveAt.delete(roomId);
    const room = await pending;
    await room.destroy();
  }

  async unloadAll(): Promise<void> {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
    await Promise.all(Array.from(this.rooms.keys()).map((id) => this.unload(id)));
  }

  /**
   * Unload any room with zero peers that has been idle longer than
   * `idleUnloadMs`. The persistence layer holds the durable copy, so
   * unloading is non-destructive — the room is rehydrated on next
   * connect.
   */
  async sweepIdle(): Promise<string[]> {
    const idleMs = this.options.idleUnloadMs;
    if (!idleMs || idleMs <= 0) return [];
    const now = Date.now();
    const candidates: string[] = [];
    for (const [roomId, pending] of this.rooms) {
      let room: Room;
      try {
        room = await pending;
      } catch {
        // A poisoned (rejected) load promise is evicted by getOrCreate's
        // own .catch handler; skip it so one bad room can't abort the sweep.
        continue;
      }
      if (room.peerCount > 0) {
        // Active rooms reset the idle clock.
        this.lastActiveAt.set(roomId, now);
        continue;
      }
      const lastActive = this.lastActiveAt.get(roomId) ?? now;
      if (now - lastActive >= idleMs) candidates.push(roomId);
    }
    for (const roomId of candidates) await this.unload(roomId);
    return candidates;
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
