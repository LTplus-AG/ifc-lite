/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MeshData } from '@ifc-lite/geometry';
import type { Scene } from './scene.js';
import { pickPieceKey } from './pick-mesh-budget.js';

type OrderScene = Pick<Scene, 'getMeshes' | 'getMeshDataPieces'>;

/**
 * The insertion order the per-piece highlight would retain (#9916).
 * Pool retirement must not forget it: hide/isolate only removes a piece from
 * the draw, whereas deselection removes its copy. New pieces append after the
 * surviving copies, irrespective of the order of a later selection Set.
 */
class SelectionHydrationOrder {
  private ranks = new WeakMap<MeshData, { rank: number; token: number }>();
  private readonly tokens = new Map<string, { token: number; id: number; model?: number; item?: number }>();
  private nextToken = 0;
  private next = 0;

  retain(scene: OrderScene, selected: ReadonlySet<number>, modelIndex?: number, itemExpressId?: number, itemId?: number): void {
    for (const [key, entry] of this.tokens) {
      if (!selected.has(entry.id) || (modelIndex !== undefined && entry.model !== modelIndex)
        || (entry.id === itemExpressId && entry.item !== itemId)) this.tokens.delete(key);
    }
    if (selected.size === 0) { this.tokens.clear(); this.ranks = new WeakMap(); this.next = 0; this.nextToken = 0; return; }
    // Picks can create individual copies before a selection starts. Seed their
    // actual scene order before recording the pieces a pool will replace.
    const ordinals = new Map<string, number>();
    for (const mesh of scene.getMeshes()) {
      if (mesh.mergedSelection || !selected.has(mesh.expressId)) continue;
      const key = `${pickPieceKey(mesh)}:${mesh.geometryItemId ?? ''}`;
      const ordinal = ordinals.get(key) ?? 0;
      ordinals.set(key, ordinal + 1);
      if (!mesh.hydrated) continue;
      const piece = scene.getMeshDataPieces(mesh.expressId, mesh.modelIndex, mesh.geometryItemId)?.[ordinal];
      if (piece) this.remember([piece]);
    }
  }

  remember(pieces: readonly MeshData[]): void {
    for (const piece of pieces) {
      const key = `${pickPieceKey(piece)}:${piece.geometryItemId ?? ''}`;
      let entry = this.tokens.get(key);
      if (!entry) {
        entry = { token: this.nextToken++, id: piece.expressId, model: piece.modelIndex, item: piece.geometryItemId };
        this.tokens.set(key, entry);
      }
      if (this.ranks.get(piece)?.token !== entry.token) this.ranks.set(piece, { rank: this.next++, token: entry.token });
    }
  }

  sort(pieces: readonly MeshData[]): MeshData[] {
    this.remember(pieces);
    return [...pieces].sort((a, b) => this.ranks.get(a)!.rank - this.ranks.get(b)!.rank);
  }
}

const orders = new WeakMap<OrderScene, SelectionHydrationOrder>();
export function selectionHydrationOrder(scene: OrderScene): SelectionHydrationOrder {
  let order = orders.get(scene);
  if (!order) { order = new SelectionHydrationOrder(); orders.set(scene, order); }
  return order;
}
