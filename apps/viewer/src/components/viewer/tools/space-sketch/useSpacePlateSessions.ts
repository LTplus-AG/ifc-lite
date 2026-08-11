/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Ownership of the Space Sketch wasm plates: one `SpacePlateSession` per
 * storey, their lifetime, and the async build that allocates into them.
 *
 * This is the piece of the overlay where a mistake costs heap rather than
 * pixels. `SpacePlateSession` owns raw Rust-heap handles freed only through
 * `dispose()`, and the build path suspends on `ensureWasm()` — so unmount can
 * land in the middle of it. `session-registry.ts` decides whether a resumed
 * build may allocate; this hook is the wiring that gives it a truthful
 * `disposed` flag and disposes everything exactly once.
 *
 * ## Why the dependencies are injected
 *
 * The overlay's only entry into this path suspends on `ensureSpaceWasm()`,
 * which rejects under the node test harness (no `fetch` for the `.wasm`), so
 * the component-level wiring around `acquireSession` had no executable test at
 * all — the guard was mutation-checked as a pure function while the code that
 * passes it `disposedRef.current` was verified by reading a diff. Taking the
 * two wasm touch points as parameters with production defaults makes the
 * suspended-across-unmount case reachable from a test: hold `ensureWasm`
 * pending, unmount, resolve, and assert nothing was allocated.
 *
 * These are ordinary parameters, not a test backdoor — the overlay passes
 * nothing and gets the real wasm.
 */

import { useCallback, useEffect, useRef } from 'react';
import {
  SpacePlateSession,
  ensureSpaceWasm,
  flattenWallRects,
  type Room,
} from '@/lib/space-plate-session';
import type { WallRect } from '@/lib/wall-rects-from-meshes';
import { acquireSession } from './session-registry';

/** Weld distance for coincident wall-rectangle corners, m. */
const CORNER_WELD_SPAN = 0.3;

export interface PlateDeps {
  /** Resolves once the space wasm module is usable. */
  ensureWasm: () => Promise<unknown>;
  /** Allocates a fresh plate session (owns wasm heap until `dispose()`). */
  createSession: () => SpacePlateSession;
}

export const defaultPlateDeps: PlateDeps = {
  ensureWasm: ensureSpaceWasm,
  createSession: () => new SpacePlateSession(),
};

export interface UseSpacePlateSessions {
  /** Every storey's plate, alive until the tool closes. */
  sessionsRef: React.RefObject<Map<number, SpacePlateSession>>;
  /** The active storey's plate. Null once the overlay has unmounted. */
  sessionRef: React.RefObject<SpacePlateSession | null>;
  /** True once unmount has disposed everything; no new plate may be built. */
  disposedRef: React.RefObject<boolean>;
  /**
   * Build `rects` into `storey`'s plate (creating it if needed) and return its
   * rooms, or `null` when this build was superseded by a newer one or the
   * overlay was unmounted while it was suspended. Rejects if the build itself
   * throws — the caller reports that to the user.
   */
  buildPlate: (rects: WallRect[], storey: number | null, snapTol: number) => Promise<Room[] | null>;
  /**
   * Allocate + register `storey`'s plate and build `rects` into it, for the
   * derive-all path (which walks every storey in one synchronous loop rather
   * than through the async `buildPlate`). Rethrows a build failure AFTER
   * disposing and unregistering the half-built session, so the storey is
   * retryable rather than stuck holding a plate nothing will free.
   */
  buildStoreyPlate: (storey: number, rects: WallRect[], snapTol: number) => Room[];
  /**
   * Resolves once the space wasm is usable — the same touch point `buildPlate`
   * uses, so the overlay reaches wasm in exactly one place and derive-all is
   * injectable for the same reason `buildPlate` is.
   */
  ensureWasm: () => Promise<unknown>;
}

export function useSpacePlateSessions(deps: PlateDeps = defaultPlateDeps): UseSpacePlateSessions {
  const sessionsRef = useRef<Map<number, SpacePlateSession>>(new Map());
  const sessionRef = useRef<SpacePlateSession | null>(null);
  const disposedRef = useRef(false);
  const buildSeqRef = useRef(0);
  // Render-phase mirror so `buildPlate` keeps a stable identity even when the
  // caller passes a fresh deps object each render — it is a dependency of
  // several effects downstream, and churning it would re-register listeners.
  const depsRef = useRef(deps);
  depsRef.current = deps;

  const buildPlate = useCallback(async (
    rects: WallRect[],
    storey: number | null,
    snapTol: number,
  ): Promise<Room[] | null> => {
    // Re-entrancy guard: a rapid rebuild (snap slider) must not let an older
    // async build free/replace the plate a newer one is using — that races the
    // shared wasm heap. Only the latest build applies; superseded ones bail.
    const seq = ++buildSeqRef.current;
    await depsRef.current.ensureWasm();
    if (seq !== buildSeqRef.current) return null;
    // Returns null once the overlay has been unmounted — unmount does NOT bump
    // `buildSeqRef`, so a build suspended on the await above would otherwise
    // resume, find the cleared registry, and build a wasm plate into a session
    // nothing is left to free (see `session-registry.ts`).
    const session = acquireSession(
      sessionsRef.current, storey, sessionRef.current, disposedRef.current,
      depsRef.current.createSession,
    );
    if (!session) return null;
    sessionRef.current = session;
    const { rooms } = session.buildFromRects(
      flattenWallRects(rects.map((r) => r.corners)), snapTol, CORNER_WELD_SPAN,
    );
    return rooms;
  }, []);

  const buildStoreyPlate = useCallback((storey: number, rects: WallRect[], snapTol: number): Room[] => {
    const session = depsRef.current.createSession();
    let rooms: Room[];
    try {
      ({ rooms } = session.buildFromRects(
        flattenWallRects(rects.map((r) => r.corners)), snapTol, CORNER_WELD_SPAN,
      ));
    } catch (e) {
      // A storey that exceeds the arrangement input cap (or otherwise fails to
      // build) must not leave a half-built draft behind. Dispose the plate we
      // just allocated — the likely throw (the input cap) fires before the
      // handle is assigned, but a throw from `rooms()`/`snapshot()` would leave
      // a live one behind — and leave the REGISTRY untouched, so a storey that
      // already had a draft keeps it instead of losing it to a failed rebuild.
      session.dispose();
      throw e;
    }
    // Registration happens only on success, for the same reason. Replacing a
    // storey's plate frees the one it replaces, and re-points `sessionRef` if
    // it was the active one — otherwise the overlay would go on editing a plate
    // that is no longer registered and would never be disposed.
    const prior = sessionsRef.current.get(storey);
    sessionsRef.current.set(storey, session);
    if (prior && prior !== session) {
      if (sessionRef.current === prior) sessionRef.current = session;
      prior.dispose();
    }
    return rooms;
  }, []);

  const ensureWasm = useCallback(() => depsRef.current.ensureWasm(), []);

  // Lifetime. Reset `disposedRef` on (re)mount so StrictMode's
  // mount/cleanup/mount cycle does not leave the overlay permanently poisoned.
  useEffect(() => {
    const sessions = sessionsRef.current;
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      // Free every storey's session (each owns wasm heap handles). Null the
      // active one in the SAME cleanup: every call site reads it optionally
      // (`sessionRef.current?.undo()`) or behind an `alive` check, so nulling
      // here is what makes a late caller a no-op rather than a use-after-free.
      const active = sessionRef.current;
      for (const s of sessions.values()) s.dispose();
      // `acquireSession`'s storey-less path hands back a session it never
      // registers, so disposing only the map's values would leak that one's
      // handles. `dispose()` is idempotent (every `free()` is optional-chained
      // and the field nulled), so a session that IS registered costs a no-op.
      active?.dispose();
      sessions.clear();
      sessionRef.current = null;
    };
  }, []);

  return { sessionsRef, sessionRef, disposedRef, buildPlate, buildStoreyPlate, ensureWasm };
}
