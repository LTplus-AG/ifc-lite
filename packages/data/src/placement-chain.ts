/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one `IfcLocalPlacement.PlacementRelTo` chain walker for TypeScript
 * (#7791 item 4, D26/D27/D30).
 *
 * Nine walkers across `packages/` and `apps/viewer` each followed
 * `PlacementRelTo` with their own loop, their own cycle guard and their own
 * depth cap (64, 128, 256, 10 000, or none). The caps silently refused a legal
 * chain that the Rust resolver composes, and nothing locked the TS answer to
 * Rust's. This walker is iterative, keeps a visited set and has NO depth cap:
 * `PlacementRelTo` has fan-out 1, so a visited set alone bounds the work, and a
 * cap would make the answer depend on where a walk started (D27).
 *
 * It only walks. Reading a link's attributes stays with the caller's
 * `parentOf`, so one walker serves the byte-range readers, the entity-store
 * readers and the overlay readers alike. The cross-language contract is pinned
 * by `rust/geometry/tests/fixtures/placement_chain_vectors.json`, which the
 * Rust resolver (`placement_chain_parity.rs`) and this walker both satisfy.
 */

/** How a {@link walkPlacementChain} walk ended. */
export type PlacementChainEnd =
  /** `parentOf` returned `null`/`undefined`: the chain reached its root. */
  | 'root'
  /** The next parent was already on the chain; see `revisited`. */
  | 'cycle'
  /** `stopAt` accepted the last id in `ids`. */
  | 'stopped';

export interface PlacementChain {
  /** The start id first, then each parent in turn. Never contains an id twice. */
  readonly ids: readonly number[];
  readonly end: PlacementChainEnd;
  /** For `end === 'cycle'`: the id that `parentOf` pointed back to. */
  readonly revisited?: number;
}

export interface PlacementChainOptions {
  /**
   * End the walk (inclusive) at the first id this accepts, without asking for
   * that id's parent: an ancestor the caller already has an answer for.
   */
  readonly stopAt?: (id: number) => boolean;
}

/**
 * Follow `parentOf` from `startId` until it has no parent, repeats an id, or
 * `stopAt` accepts one. `parentOf` returns `null`/`undefined` for "no parent"
 * (a root, an unreadable link and a non-placement all end the walk the same
 * way; a caller that must tell them apart checks the last id itself).
 */
export function walkPlacementChain(
  startId: number,
  parentOf: (id: number) => number | null | undefined,
  options: PlacementChainOptions = {},
): PlacementChain {
  const ids: number[] = [];
  const seen = new Set<number>();
  let id: number = startId;
  for (;;) {
    ids.push(id);
    seen.add(id);
    if (options.stopAt?.(id)) return { ids, end: 'stopped' };
    const parent = parentOf(id);
    if (parent === null || parent === undefined) return { ids, end: 'root' };
    if (seen.has(parent)) return { ids, end: 'cycle', revisited: parent };
    id = parent;
  }
}
