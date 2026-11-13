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
import type { Persistence } from './persistence.js';
import type { Principal } from './auth.js';
import { closeExpiredConnections, sweepExpiredAcrossRooms } from './principal-expiry.js';
import { writeFrameRejection } from './write-frame-gate.js';
import { RoomWriter } from './room-writer.js';
import type { VerifyDecision, VerifyMessageFn, RoomOptions, PeerConnection } from './room-types.js';
import {
  noopAuditSink,
  shortHash,
  type AuditOpType,
  type AuditSink,
} from './audit-log.js';
import { createRateLimiter, type RateLimitOptions } from './rate-limit.js';
import { safeSend } from './safe-send.js';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

/**
 * An awareness update naming ZERO clients: a single varUint `0` length prefix.
 * `applyAwarenessUpdate` decodes it as a no-op, but it is a real WebSocket
 * message, which is the point. See `Room.sendKeepalive`.
 */
const EMPTY_AWARENESS_UPDATE = new Uint8Array([0]);

/**
 * Hard ceiling on a single awareness frame. Presence/cursor payloads are
 * tiny; anything larger is abuse. Caps the decode + broadcast amplification
 * an unmetered awareness flood could drive.
 */
const MAX_AWARENESS_BYTES = 128 * 1024;

// Public type surface lives in room-types.ts (module-size budget, AGENTS.md);
// re-exported here unchanged so this split is not a public API move.
export type { VerifyDecision, VerifyMessageFn, RoomOptions, PeerConnection };

export class Room {
  readonly id: string;
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  private readonly conns = new Set<PeerConnection>();
  private readonly persistence: Persistence;
  private readonly writer: RoomWriter; // one write in flight; see room-writer.ts
  private readonly auditSink: AuditSink;
  private readonly rateLimitFor: (principal: Principal) => RateLimitOptions;
  private readonly verifyMessage?: VerifyMessageFn;
  private counters: { update?: () => void; reject?: (reason: string) => void };
  private destroyed = false;

  constructor(id: string, opts: RoomOptions) {
    this.id = id;
    this.doc = new Y.Doc();
    this.awareness = new Awareness(this.doc);
    // y-protocols' Awareness constructor self-registers a local state of `{}`
    // for its own clientID and renews it every ~15s. The server is a relay,
    // not a participant: left in place, that entry is broadcast to every
    // client as a peer, so every room badge read one too high (#2791). It
    // showed "(2)" directly above a roster saying "You're the only one here",
    // because the roster filters on a `user` field and the badge did not.
    // Clearing the state also stops the renewal, which y-protocols guards on
    // `getLocalState() !== null`.
    // This must stay BEFORE the `update` listener is wired up below, so that
    // clearing it cannot broadcast a removal for a peer no client ever saw.
    this.awareness.setLocalState(null);
    this.persistence = opts.persistence;
    this.writer = new RoomWriter({
      roomId: id,
      persistence: opts.persistence,
      compactEvery: opts.compactEvery ?? 1000,
      snapshot: () => Y.encodeStateAsUpdate(this.doc),
    });
    this.auditSink = opts.auditSink ?? noopAuditSink;
    const rl = opts.rateLimit;
    this.rateLimitFor = typeof rl === 'function' ? rl : () => rl ?? {};
    this.verifyMessage = opts.verifyMessage;
    this.counters = opts.counters ?? {};

    this.doc.on('update', this.onDocUpdate);
    this.awareness.on('update', this.onAwarenessUpdate);
  }

  setCounters(counters: { update?: () => void; reject?: (reason: string) => void }): void { this.counters = counters; }

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

  /**
   * Force-disconnect the peer that owns the given awareness clientId (admin
   * "kick"). Closing the socket triggers the normal removeConnection cleanup,
   * which clears the peer's awareness state for everyone. Returns whether a
   * matching connection was found plus the peer's token `jti` (if any) so the
   * caller can revoke it — otherwise the client's y-websocket simply reconnects
   * with the same still-valid token.
   */
  kickClient(clientId: number): { kicked: boolean; jti?: string } {
    for (const conn of this.conns) {
      if (conn.awarenessClients.has(clientId)) {
        const jti = typeof conn.principal.meta?.jti === 'string' ? conn.principal.meta.jti : undefined;
        try {
          conn.ws.close(4403, 'kicked');
        } catch {
          /* socket may already be torn down */
        }
        return { kicked: true, jti };
      }
    }
    return { kicked: false };
  }

  /** #3441 periodic expiry re-check; see principal-expiry.ts. */
  sweepExpiredPrincipals(now: number = Date.now()): number {
    return closeExpiredConnections(this.conns, now);
  }

  /** Number of currently connected peers. */
  get peerCount(): number {
    return this.conns.size;
  }

  /** Registers the peer; false (and nothing registered) once destroyed. */
  addConnection(conn: PeerConnection): boolean {
    if (this.destroyed) return false;
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
    return true;
  }

  /**
   * Send an application-level keepalive to one peer.
   *
   * y-websocket's client closes a connection after
   * `messageReconnectTimeout` (30s, a module-level const, not configurable)
   * with no inbound MESSAGE, and only `websocket.onmessage` refreshes that
   * clock (y-websocket/src/y-websocket.js:186,387-396). WebSocket protocol
   * pings do not count: they are auto-ponged below the message layer, so the
   * `ws.ping()` loop in `server.ts` cannot feed it.
   *
   * This server does not echo a peer's own updates back to it
   * (`if (conn === origin) continue;` below, and the same for doc updates), so
   * a room with ONE occupant produces no server-to-client traffic at all after
   * the initial handshake. y-websocket's own comment says the timeout assumes
   * "not even your own awareness updates (which are updated every 15 seconds)"
   * come back, i.e. the reference server echoes them and ours does not.
   *
   * Until #2791 that gap was masked by an accident: the server's own Awareness
   * ghost state renewed every ~15s and was broadcast to everyone, feeding the
   * watchdog. Clearing the ghost removes the accident, so the keepalive has to
   * be explicit. Measured: with the ghost gone and no keepalive, a lone client
   * closed and reconnected at t=30s and t=63s over a 75s window; with either
   * one present, zero closes.
   */
  sendKeepalive(conn: PeerConnection): void {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(enc, EMPTY_AWARENESS_UPDATE);
    safeSend(conn.ws, encoding.toUint8Array(enc));
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
    let dispatchable = msg;
    if (this.verifyMessage) {
      const decision = this.verifyMessage(msg, conn);
      if (!decision.ok) {
        const reason = decision.reason ?? 'verify-failed';
        this.audit(conn.principal, 'reject', shortHash(msg), { reason });
        this.counters.reject?.(reason);
        return;
      }
      // A verifier that unwraps an outer envelope (e.g. the anti-replay
      // protector's signed frame) hands back the inner y-protocol frame
      // here; dispatch THAT, not the raw envelope bytes — the envelope
      // isn't itself a valid sync/awareness frame.
      if (decision.payload) {
        dispatchable = decision.payload;
        // The preCheckWriteFrame call above read the ENVELOPE (msg), whose
        // outer varint is the verifier's own tag (e.g. SIGNED_TAG) and never
        // MESSAGE_SYNC, so it returned true without consulting the role, the
        // limiter, or the size cap (see preCheckWriteFrame's early return).
        // decision.payload is a real, unwrapped write frame that peek never
        // saw — re-run the same gate on the bytes we are actually about to
        // dispatch, or a viewer holding a valid signing key can write to the
        // doc, and an oversized/unrate-limited envelope bypasses the caps
        // meant to bound Y.Doc-parse amplification.
        if (!this.preCheckWriteFrame(conn, dispatchable)) return;
      }
    }
    try {
      this.dispatchMessage(conn, dispatchable);
    } catch {
      // Malformed/truncated frame from a peer. lib0 decoding throws
      // (errorUnexpectedEndOfArray / RangeError) on short or oversized
      // varint frames; never let that reach the ws listener as an
      // uncaughtException — it would kill the whole process.
      this.audit(conn.principal, 'reject', shortHash(msg), { reason: 'malformed' });
      this.counters.reject?.('malformed');
    }
  }

  /** See write-frame-gate.ts; a rejection is audited and counted here. */
  private preCheckWriteFrame(conn: PeerConnection, msg: Uint8Array): boolean {
    const reason = writeFrameRejection(conn, msg);
    if (reason === null) return true;
    this.audit(conn.principal, 'reject', shortHash(msg), { reason });
    this.counters.reject?.(reason);
    return false;
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
    this.writer.enqueue(update);
  };

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

  /** Close connections and detach the doc/awareness listeners. Shared by
   * `destroy()` and `disposeUnloaded()`; does not touch persistence. */
  private closeConnsAndListeners(): void {
    this.destroyed = true;
    for (const conn of this.conns) {
      try { conn.ws.close(); } catch { /* socket may already be torn down */ }
    }
    this.conns.clear();
    this.doc.off('update', this.onDocUpdate);
    this.awareness.off('update', this.onAwarenessUpdate);
  }

  /**
   * Tear down a room that never finished loading. Same disposal as
   * `destroy()` MINUS the final compaction: this room's `doc` is empty or
   * partial because `loadFromDisk()` threw, so compacting it would replace
   * the persisted log with that emptiness -- turning a transient disk error
   * (EMFILE, ENOSPC, an NFS blip) or a corrupt log into permanent data loss.
   * Compaction is only ever valid for a doc that loaded successfully.
   */
  async disposeUnloaded(): Promise<void> {
    this.closeConnsAndListeners();
    this.awareness.destroy();
    this.doc.destroy();
  }

  async destroy(): Promise<void> {
    this.closeConnsAndListeners();
    // Final compaction so the next load picks up the freshest state, after
    // the write in flight (an older compaction landing last would roll back).
    await this.writer.closeAndCompact();
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
  /** In-flight unloads by id; a reload waits for the final compaction. */
  private readonly unloading = new Map<string, Promise<void>>();
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private counters: RoomCounters = {};
  private closed = false; // set by shutdown(): a join mid-setup must not load a room it missed

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
    if (this.closed) throw new Error('@ifc-lite/collab-server: room manager is shut down');
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
      // The old instance's final compaction REPLACES the persisted log (every
      // backend), so loading and appending before it lands loses our appends.
      await this.unloading.get(roomId);
      const room = new Room(roomId, { ...this.options, counters, verifyMessage });
      // `new Room(...)` already started disposables (notably y-protocols'
      // `Awareness`, which self-starts a `setInterval` renewal/eviction
      // timer in its constructor) and wired `doc`/`awareness` listeners.
      // If loadFromDisk() throws, `room` is never returned to any caller,
      // so nothing outside this closure can reach it to dispose those
      // handles — they would otherwise leak for the life of the process.
      // Tear the half-built room down here, where we still hold the only
      // reference, then rethrow so the promise still rejects as before.
      //
      // Use disposeUnloaded(), NOT destroy(): destroy() ends with a final
      // compact() of `room.doc` onto the persisted log, and on this path
      // `room.doc` is empty or partial (that is what loadFromDisk() failing
      // means). A transient EMFILE/ENOSPC blip -- or a corrupt log -- would
      // otherwise be turned into permanent data loss by the "cleanup" that
      // runs right here.
      try {
        await room.loadFromDisk();
      } catch (err) {
        await room.disposeUnloaded().catch((disposeErr) => {
          // eslint-disable-next-line no-console
          console.error(`[collab-server] disposeUnloaded error for ${roomId} (original error wins):`, disposeErr);
        });
        throw err;
      }
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

  /** Server stop only: refuse loads for good (from this call on), then unloadAll(). */
  async shutdown(): Promise<void> {
    if (this.idleTimer) clearInterval(this.idleTimer); // the manager never serves again
    this.closed = true;
    await this.unloadAll();
  }

  list(): string[] {
    return Array.from(this.rooms.keys());
  }

  /** The pending Room for a loaded room id, or undefined when not loaded.
   *  Unlike `getOrCreate` this never creates: admin actions (kick) target only
   *  rooms that actually exist. */
  peek(roomId: string): Promise<Room> | undefined {
    return this.rooms.get(roomId);
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
    await this.trackUnload(roomId, pending.then((room) => room.destroy()));
  }

  private trackUnload(roomId: string, task: Promise<void>): Promise<void> {
    const settled = task.catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[collab-server] unload failed for ${roomId}:`, err);
    });
    this.unloading.set(roomId, settled);
    void settled.then(() => {
      if (this.unloading.get(roomId) === settled) this.unloading.delete(roomId);
    });
    return task;
  }

  /** Evict every room; manager and idle sweep keep serving. All settle, each failure is logged, the first rethrown. */
  async unloadAll(): Promise<void> {
    const settled = await Promise.allSettled(Array.from(this.rooms.keys(), (id) => this.unload(id)));
    // Unloads the idle sweep already started: their compaction must land too.
    // Drain until empty so an unload tracked after this snapshot still counts.
    while (this.unloading.size > 0) await Promise.all(this.unloading.values());
    const failed = settled.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []));
    for (const err of failed) console.error('[collab-server] room unload failed:', err);
    if (failed.length > 0) throw failed[0];
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
    const candidates: Array<[string, Promise<Room>]> = [];
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
      if (now - lastActive >= idleMs) candidates.push([roomId, pending]);
    }
    const unloaded: string[] = [];
    for (const [roomId, pending] of candidates) {
      // Re-check at unload time: a peer may have joined while an earlier
      // candidate compacted, and unloading it would close a live socket.
      const room = await pending;
      if (this.rooms.get(roomId) !== pending || room.peerCount > 0) continue;
      if (Date.now() - (this.lastActiveAt.get(roomId) ?? 0) < idleMs) continue;
      this.rooms.delete(roomId);
      this.lastActiveAt.delete(roomId);
      // destroy() marks the room destroyed synchronously: no join slips in.
      await this.trackUnload(roomId, room.destroy());
      unloaded.push(roomId);
    }
    return unloaded;
  }

  /** Across every loaded room; see principal-expiry.ts. Timer: server.ts. */
  sweepExpiredPrincipals(now: number = Date.now()): Promise<number> {
    return sweepExpiredAcrossRooms(this.rooms.values(), now);
  }
}
