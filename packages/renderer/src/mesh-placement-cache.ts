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
 * One cache's link, kept on the mesh itself under {@link LINK} (not enumerable, so a spread copy does not
 * inherit it). `owner` is the object the link was written on: a copy that took the property anyway (a
 * compact shell copy duplicates every own property) carries a foreign owner and is not linked. `next`
 * holds the links of other caches (another Scene) on the same mesh.
 */
interface Link {
  owner: object;
  cache: MeshPlacementCache;
  /** On a placed copy: its placement, held strongly, as long as the copy lives. */
  placement?: MeshPlacement;
  /** On a source: its placement, held weakly, valid for one source generation. */
  weak?: WeakRef<MeshPlacement>;
  generation?: number;
  next?: Link;
}

const LINK = Symbol('ifc-lite.meshPlacement');
type Linked = { [LINK]?: Link };

function linkOf(mesh: MeshData, cache: MeshPlacementCache): Link | undefined {
  for (let link = (mesh as Linked)[LINK]; link; link = link.next) {
    if (link.owner !== mesh) return undefined; // copied from another mesh: none of it is ours
    if (link.cache === cache) return link;
  }
  return undefined;
}

/** This cache's link on `mesh`, created if missing; `undefined` when the mesh cannot take one (frozen). */
function ensureLink(mesh: MeshData, cache: MeshPlacementCache): Link | undefined {
  const own = linkOf(mesh, cache);
  if (own) return own;
  if (!Object.isExtensible(mesh)) return undefined;
  const head = (mesh as Linked)[LINK];
  const link: Link = { owner: mesh, cache, next: head?.owner === mesh ? head : undefined };
  Object.defineProperty(mesh, LINK, { value: link, writable: true, configurable: true, enumerable: false });
  return link;
}

/**
 * Placed copies looked up by source or by placed copy (`ModelTranslations.placeMesh`).
 *
 * Every mesh of every model gets a placed copy, moved or not, so this holds one entry per loaded mesh.
 * It used to be two WeakMaps. Their entries are ephemerons, which every full garbage collection marks in
 * repeated passes: with four 275k-mesh models loaded, most of each collection went there, and each further
 * federation slot loaded slower than the one before. The links now live on the meshes:
 *
 * - A placed copy holds its placement strongly, so a retained copy keeps resolving to its source and is
 *   never placed a second time. It goes when nobody holds the copy.
 * - A source holds its placement weakly. Whoever keeps the copy's identity (a bucket's `meshData`, the
 *   `meshDataBucket` keys, compact members, edit sets) holds the copy strongly, so `placeMesh` keeps
 *   returning that copy; a copy nobody holds can be collected and is made again on demand. The source
 *   therefore never keeps a copy, or the shared arrays it points at, alive.
 *
 * `forgetSources` runs when the scene releases its CPU geometry: it starts a new source generation, so a
 * source gets a fresh placement on demand, as when the source-keyed map was dropped. Frozen meshes, which
 * cannot take a link, fall back to WeakMaps.
 */
export class MeshPlacementCache {
  private generation = 0;
  private bySource = new WeakMap<MeshData, MeshPlacement>();
  private byPlaced = new WeakMap<MeshData, MeshPlacement>();

  get(mesh: MeshData): MeshPlacement | undefined {
    const link = linkOf(mesh, this);
    if (link?.placement) return link.placement;
    if (link?.weak && link.generation === this.generation) {
      const placement = link.weak.deref();
      if (placement) return placement;
    }
    return this.byPlaced.get(mesh) ?? this.bySource.get(mesh);
  }

  set(entry: MeshPlacement): void {
    const placed = ensureLink(entry.placed, this);
    if (placed) placed.placement = entry; else this.byPlaced.set(entry.placed, entry);
    const source = ensureLink(entry.source, this);
    if (source && !source.placement) { source.weak = new WeakRef(entry); source.generation = this.generation; }
    else if (!source) this.bySource.set(entry.source, entry);
  }

  forgetSources(): void {
    this.generation++;
    this.bySource = new WeakMap();
  }
}
