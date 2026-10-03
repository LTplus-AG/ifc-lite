/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** One bounded native-plate ownership/history policy for all Room hosts (#6232 D5). */
import { readFaces, flattenRoomRects, type LayoutFace, type RoomPlate, type RoomPlateFactory, type Pt } from './room-layout-core.js';

export interface RetainedRoomLayout { readonly walls: string; readonly plate: RoomPlate; readonly faces: LayoutFace[] }
interface Scope { modelId: string; entries: Map<string, RetainedRoomLayout>; last: RetainedRoomLayout | null }
const MAX_HISTORY = 40;
export function roomWallsSignature(rects: readonly (readonly Pt[])[]): string {
  return rects.map(r => r.map(p => `${p[0].toFixed(3)},${p[1].toFixed(3)}`).join(';')).join('|');
}

/** Every retained handle is freed on replacement, eviction, model removal or dispose. */
export class RoomLayoutCache {
  private readonly scopes = new Map<string, Scope>();
  private revision = 0;
  version(): number { return this.revision; }
  private scope(modelId: string, storeyId: number, weld: number): Scope {
    const key = JSON.stringify([modelId, storeyId, weld]);
    const held = this.scopes.get(key);
    if (held) return held;
    const scope = { modelId, entries: new Map<string, RetainedRoomLayout>(), last: null };
    this.scopes.set(key, scope);
    return scope;
  }
  private drop(scope: Scope, head: string): void {
    const entry = scope.entries.get(head);
    if (!entry) return;
    if (scope.last === entry) scope.last = null;
    entry.plate.free();
    scope.entries.delete(head);
  }
  private retain(scope: Scope, head: string, entry: RetainedRoomLayout): void {
    if (scope.entries.get(head) !== entry) this.drop(scope, head);
    scope.entries.delete(head);
    scope.entries.set(head, entry);
    scope.last = entry;
    this.revision++;
    while (scope.entries.size > MAX_HISTORY) this.drop(scope, scope.entries.keys().next().value!);
  }
  read(modelId: string, storeyId: number, weld: number, head: string, rects: readonly (readonly Pt[])[], factory: RoomPlateFactory): RetainedRoomLayout {
    const scope = this.scope(modelId, storeyId, weld), walls = roomWallsSignature(rects);
    let entry = scope.entries.get(head);
    if (!entry || entry.walls !== walls) {
      const carried = scope.last?.walls === walls ? scope.last : null;
      const plate = carried ? carried.plate.duplicate() : factory.fromWallRects(flattenRoomRects(rects), weld, Number.MIN_VALUE);
      try {
        entry = { walls, plate, faces: carried?.faces ?? readFaces(plate) };
        this.retain(scope, head, entry);
      } catch (error) { plate.free(); throw error; }
    }
    scope.last = entry;
    return entry;
  }
  /** Transfer ownership only after the IFC/history commit has succeeded. */
  file(modelId: string, storeyId: number, weld: number, head: string, walls: string, plate: RoomPlate): void {
    const entry = { walls, plate, faces: readFaces(plate) };
    this.retain(this.scope(modelId, storeyId, weld), head, entry);
  }
  clearModel(modelId: string): void {
    for (const [key, scope] of this.scopes) {
      if (scope.modelId !== modelId) continue;
      for (const entry of scope.entries.values()) entry.plate.free();
      this.scopes.delete(key);
    }
    this.revision++;
  }
  clear(): void {
    for (const scope of this.scopes.values()) for (const entry of scope.entries.values()) entry.plate.free();
    this.scopes.clear();
    this.revision++;
  }
}
