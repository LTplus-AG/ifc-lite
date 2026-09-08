/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Session acquisition for the Space Sketch overlay's per-storey plate registry.
 *
 * Split out of `SpaceSketchOverlay.tsx` because the interesting case is a
 * lifecycle race that cannot be reached from a component test: the overlay's
 * only entry point suspends on `ensureSpaceWasm()`, which rejects outright
 * under the node test harness (there is no `fetch` for the `.wasm`), and this
 * repo does not run node's flag-gated `mock.module`. As a plain function the
 * post-await state is expressible directly.
 *
 * The race: `buildFrom` awaits `ensureSpaceWasm()`, and the overlay's unmount
 * cleanup disposes every session and clears the registry. Unmount does NOT
 * bump the build sequence, so a build suspended across it resumes, finds the
 * cleared registry, and constructs a `SpacePlateSession` that it then builds a
 * wasm plate into — with nothing left alive to free it. Closing the tool
 * mid-derive leaked that plate on the shared dlmalloc heap.
 */

import type { SpacePlateSession } from '@/lib/space-plate-session';

/**
 * The session a build should act on, or `null` when the overlay has already
 * been torn down and no new session may be allocated.
 *
 * `storey === null` is the legacy single-plate path: it reuses whatever
 * session is currently active and never registers into the per-storey map.
 *
 * `make` is only invoked when a session genuinely has to be created, so a
 * disposed registry costs nothing and — the point of the guard — leaks
 * nothing.
 */
export function acquireSession(
  registry: Map<number, SpacePlateSession>,
  storey: number | null,
  active: SpacePlateSession | null,
  disposed: boolean,
  make: () => SpacePlateSession,
): SpacePlateSession | null {
  if (disposed) return null;
  const existing = storey != null ? registry.get(storey) : active;
  if (existing) return existing;
  const session = make();
  if (storey != null) registry.set(storey, session);
  return session;
}
