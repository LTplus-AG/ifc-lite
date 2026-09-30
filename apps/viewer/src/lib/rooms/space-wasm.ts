/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The wasm space module the Room tool's layout runs on (`SpacePlateHandle`,
 * the storey's room DCEL), and the shapes its snapshot returns.
 *
 * The handle owns Rust-side `Vec`s on the shared dlmalloc heap, so it must be
 * freed deterministically (never via JS GC): the layout code in
 * `room-layout.ts` duplicates / frees it explicitly.
 */

import init from '@ifc-lite/wasm';

/** One room (face) of a plate snapshot: its centreline outline. */
export interface Room {
  face: number;
  area: number;
  simple: boolean;
  outline: [number, number][];
}

/** One wall edge bounding a room, with the source wall it came from. */
export interface Boundary {
  edge: number;
  source: number | null;
}

let wasmReady: Promise<void> | null = null;
let wasmLoaded = false;
/** Initialise the wasm module once (idempotent). */
export function ensureSpaceWasm(): Promise<void> {
  if (!wasmReady) wasmReady = init().then(() => { wasmLoaded = true; });
  return wasmReady;
}
/** Whether `ensureSpaceWasm` has resolved, for a synchronous caller (a pointer move). */
export function spaceWasmLoaded(): boolean {
  return wasmLoaded;
}
