/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MeshData } from '@ifc-lite/geometry';

/** A source mesh and its placed copy, which shares the source's typed arrays. */
export interface MeshPlacement {
  source: MeshData;
  placed: MeshData;
}

/**
 * Placed copies looked up by source or by placed copy (`ModelTranslations.placeMesh`).
 *
 * `forgetSources` runs when the scene releases its CPU geometry. The store keeps each source alive, so a
 * source-keyed entry would hold every shared array past an in-place release. Placed-keyed entries stay: a
 * placed copy holds the shared arrays as its own fields, so whoever retains the copy retains them anyway,
 * and the entry adds only the copy -> source link, without which a retained copy would be placed a second
 * time. The key is the copy itself, held weakly, so the entry goes when nobody holds the copy.
 */
export class MeshPlacementCache {
  private bySource = new WeakMap<MeshData, MeshPlacement>();
  private byPlaced = new WeakMap<MeshData, MeshPlacement>();

  get(mesh: MeshData): MeshPlacement | undefined { return this.byPlaced.get(mesh) ?? this.bySource.get(mesh); }

  set(entry: MeshPlacement): void { this.bySource.set(entry.source, entry); this.byPlaced.set(entry.placed, entry); }

  forgetSources(): void { this.bySource = new WeakMap(); }
}
