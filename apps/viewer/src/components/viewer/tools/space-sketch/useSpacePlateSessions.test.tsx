/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Space Sketch plate lifetime, at the level where it actually goes wrong:
 * a build suspended across the overlay's unmount.
 *
 * `acquireSession` (session-registry.ts) has been mutation-checked as a pure
 * function since #1344, but the COMPONENT-LEVEL wiring around it had no
 * executable test at all — the overlay's only entry into that path suspends on
 * `ensureSpaceWasm()`, which rejects under the node harness, so the code that
 * decides what `disposedRef.current` is at the moment `acquireSession` is
 * called was verified by reading a three-line diff. Taking the wasm touch
 * points as injected dependencies is what makes it reachable: this file holds
 * `ensureWasm` pending, unmounts, then resolves.
 *
 * The leak these guard: `SpacePlateSession` owns raw Rust-heap handles freed
 * only through `dispose()`. A resumed build that allocates a fresh session into
 * a registry the unmount already cleared builds a wasm plate nothing is left to
 * free — closing the tool mid-derive leaked it (#2438 / #1344).
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SpacePlateSession } from '@/lib/space-plate-session.js';
import type { WallRect } from '@/lib/wall-rects-from-meshes.js';
import {
  useSpacePlateSessions,
  type PlateDeps,
  type UseSpacePlateSessions,
} from './useSpacePlateSessions.js';

/** A one-metre square wall rectangle — the build input's shape is all we need. */
const RECTS: WallRect[] = [
  {
    corners: [[0, 0], [1, 0], [1, 1], [0, 1]],
    centreline: [[0, 0], [1, 0]],
    thickness: 0.2,
  } as unknown as WallRect,
];

/** Every session the fake `createSession` handed out, with its dispose state. */
interface FakeSession {
  disposed: boolean;
  built: number;
  session: SpacePlateSession;
}

function makeFakeDeps(): {
  deps: PlateDeps;
  sessions: FakeSession[];
  /** Resolve every outstanding `ensureWasm()` — there can be more than one. */
  releaseWasm: () => void;
} {
  const sessions: FakeSession[] = [];
  const pending: Array<() => void> = [];
  const deps: PlateDeps = {
    ensureWasm: () => new Promise<void>((resolve) => { pending.push(resolve); }),
    createSession: () => {
      const entry: FakeSession = {
        disposed: false,
        built: 0,
        session: null as unknown as SpacePlateSession,
      };
      entry.session = {
        alive: true,
        dispose() { entry.disposed = true; },
        buildFromRects() { entry.built++; return { rooms: [] }; },
      } as unknown as SpacePlateSession;
      sessions.push(entry);
      return entry.session;
    },
  };
  return {
    deps,
    sessions,
    releaseWasm: () => { while (pending.length > 0) pending.shift()!(); },
  };
}

let root: Root | null = null;
let container: HTMLElement | null = null;
let api: UseSpacePlateSessions | null = null;

function Harness({ deps }: { deps: PlateDeps }) {
  api = useSpacePlateSessions(deps);
  return null;
}

function mount(deps: PlateDeps): void {
  act(() => { root!.render(<Harness deps={deps} />); });
}

function unmount(): void {
  act(() => { root!.unmount(); });
  root = null;
}

/** Let the resolved `ensureWasm` promise's continuation run. */
async function settle(): Promise<void> {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  api = null;
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container?.remove();
});

describe('useSpacePlateSessions', () => {
  it('builds into a session it registers under the storey', async () => {
    const { deps, sessions, releaseWasm } = makeFakeDeps();
    mount(deps);
    const built = api!.buildPlate(RECTS, 7, 0.05);
    releaseWasm();
    const rooms = await built;
    assert.deepEqual(rooms, [], 'a completed build returns the plate rooms');
    assert.equal(sessions.length, 1, 'one session allocated');
    assert.equal(sessions[0].built, 1, 'and the plate was built into it');
    assert.equal(api!.sessionsRef.current.get(7), sessions[0].session);
    assert.equal(api!.sessionRef.current, sessions[0].session, 'and it became active');
  });

  it('reuses a storey session instead of allocating a second plate', async () => {
    const { deps, sessions, releaseWasm } = makeFakeDeps();
    mount(deps);
    const first = api!.buildPlate(RECTS, 7, 0.05);
    releaseWasm();
    await first;
    const second = api!.buildPlate(RECTS, 7, 0.05);
    releaseWasm();
    await second;
    assert.equal(sessions.length, 1, 'the storey keeps its plate across rebuilds');
    assert.equal(sessions[0].built, 2, 'which is rebuilt in place');
  });

  it('allocates NOTHING when the overlay unmounts while the build is suspended', async () => {
    // The #2438 leak, end to end through the component wiring: the build is
    // parked on `ensureWasm()` when the user closes the tool. Unmount does not
    // bump the build sequence, so nothing but `disposedRef` stops the resumed
    // build from constructing a plate into the cleared registry.
    const { deps, sessions, releaseWasm } = makeFakeDeps();
    mount(deps);
    const pending = api!.buildPlate(RECTS, 7, 0.05);
    const held = api!;
    assert.equal(sessions.length, 0, 'nothing is allocated before the wasm resolves');

    unmount();
    assert.equal(held.disposedRef.current, true, 'unmount marks the overlay disposed');

    releaseWasm();
    const rooms = await pending;
    await settle();

    assert.equal(rooms, null, 'a build resuming after unmount applies nothing');
    assert.equal(sessions.length, 0, 'and allocates no wasm plate at all');
    assert.equal(held.sessionsRef.current.size, 0, 'the cleared registry stays cleared');
    assert.equal(held.sessionRef.current, null, 'and no session is re-attached');
  });

  it('disposes every storey plate on unmount, exactly once', async () => {
    const { deps, sessions, releaseWasm } = makeFakeDeps();
    mount(deps);
    for (const storey of [3, 4]) {
      const p = api!.buildPlate(RECTS, storey, 0.05);
      releaseWasm();
      await p;
    }
    assert.equal(sessions.length, 2, 'one plate per storey');
    const held = api!;
    unmount();
    assert.deepEqual(sessions.map((s) => s.disposed), [true, true], 'both plates freed');
    assert.equal(held.sessionsRef.current.size, 0);
    assert.equal(held.sessionRef.current, null);
  });

  it('lets only the newest build apply when two overlap', async () => {
    // The snap slider fires a rebuild per tick. An older build resuming late
    // must not replace the plate a newer one is already using.
    const { deps, sessions, releaseWasm } = makeFakeDeps();
    mount(deps);
    const stale = api!.buildPlate(RECTS, 7, 0.05);
    const fresh = api!.buildPlate(RECTS, 7, 0.02);
    releaseWasm(); // both builds resume; only the newer one may apply
    assert.equal(await stale, null, 'the superseded build applies nothing');
    assert.deepEqual(await fresh, [], 'the newest build applies');
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].built, 1, 'and the plate is built exactly once');
  });

  it('unregisters and frees a storey plate whose build throws', () => {
    // derive-all walks every storey; one that blows the arrangement input cap
    // must leave nothing behind, or the storey is stuck holding a live handle
    // that never produced rooms.
    const sessions: FakeSession[] = [];
    const deps: PlateDeps = {
      ensureWasm: () => Promise.resolve(),
      createSession: () => {
        const entry: FakeSession = { disposed: false, built: 0, session: null as unknown as SpacePlateSession };
        entry.session = {
          alive: true,
          dispose() { entry.disposed = true; },
          buildFromRects() { throw new Error('arrangement input cap'); },
        } as unknown as SpacePlateSession;
        sessions.push(entry);
        return entry.session;
      },
    };
    mount(deps);
    assert.throws(() => api!.buildStoreyPlate(5, RECTS, 0.05), /arrangement input cap/);
    assert.equal(sessions.length, 1, 'a session was allocated before the throw');
    assert.equal(sessions[0].disposed, true, 'and freed on the way out');
    assert.equal(api!.sessionsRef.current.has(5), false, 'the storey is retryable');
  });

  it('clears the disposed flag on remount, so StrictMode does not poison it', async () => {
    // React StrictMode mounts, runs the cleanup, then mounts again. If
    // `disposedRef` stayed true after that cycle the overlay could never build
    // anything for the rest of its life.
    const { deps, sessions, releaseWasm } = makeFakeDeps();
    mount(deps);
    unmount();
    root = createRoot(container!);
    mount(deps);
    assert.equal(api!.disposedRef.current, false, 'a fresh mount is not disposed');
    const p = api!.buildPlate(RECTS, 7, 0.05);
    releaseWasm();
    assert.deepEqual(await p, [], 'and can still build');
    assert.equal(sessions.length, 1);
  });
});
