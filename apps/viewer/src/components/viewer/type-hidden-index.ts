/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Type visibility as entity ids, not as a filtered upload (#10264).
 *
 * The class toggles (spaces, openings, ...), the Model/Types switch and the
 * structural modes used to drop meshes from the list the scene uploads, so a
 * toggle re-uploaded the scene from the CPU arrays. Every mesh is now uploaded
 * once and a toggle only changes which entity ids the viewport hides, through
 * the same GPU hide table as the user's own hides (#10264 S2).
 *
 * The index keeps, per (geometry class, IFC class) pair, the ids of the
 * entities whose meshes carry it, appended as meshes stream in. It reads a
 * mesh's `expressId`, `ifcType`, `geometryClass` and per-vertex `entityIds`
 * when the mesh arrives and keeps none of its arrays, so it still answers
 * after the CPU geometry is released.
 *
 * The verdict is per entity. An entity is hidden when any of its meshes is
 * hidden: in-tree meshes of one entity share their class and their verdict
 * (type-library meshes carry the type's own id, and occurrences and layer
 * slices are both model geometry), so this matches the per-mesh filter.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { StructuralViewMode } from '@/store/types';
import { isTypeVisible, type RetypedClasses, type TypeVisibilityGate } from '@/store/typeVisibilityFilter';
import { isMeshVisibleInViewMode, type TypeViewMode } from '@/lib/type-view-visibility';

/** What decides the type-hidden set. */
export interface TypeHiddenSettings {
  typeVisibility: TypeVisibilityGate;
  viewMode: TypeViewMode;
  hasOccurrenceGeometry: boolean;
  structuralViewMode: StructuralViewMode;
  retyped?: RetypedClasses;
}

/**
 * The ids type visibility hides, global ids as every mesh list carries them.
 * A change of content is a new `ids` Set and a new `version`, so consumers
 * memoised on the Set's identity see a streamed batch's hidden ids too.
 * Consumers read it and never write it.
 */
export interface TypeHiddenIds {
  readonly ids: Set<number>;
  readonly version: number;
}

type MeshFields = Pick<MeshData, 'expressId' | 'ifcType' | 'geometryClass' | 'entityIds'>;

interface Bucket {
  geometryClass: number;
  ifcType: string | undefined;
  ids: Float64Array;
  length: number;
}

const GATE_KEYS = ['spaces', 'spatialZones', 'openings', 'virtualElements', 'site', 'ifcAnnotations'] as const;

function sameSettings(a: TypeHiddenSettings, b: TypeHiddenSettings): boolean {
  return a.viewMode === b.viewMode && a.hasOccurrenceGeometry === b.hasOccurrenceGeometry
    && a.structuralViewMode === b.structuralViewMode && a.retyped === b.retyped
    && GATE_KEYS.every((key) => a.typeVisibility[key] === b.typeVisibility[key]);
}

/** The entity ids one mesh stands for: its own and any distinct per-vertex ids. */
function meshIds(mesh: MeshFields, visit: (id: number) => void): void {
  visit(mesh.expressId);
  const lane = mesh.entityIds;
  if (!lane?.length) return;
  let previous = mesh.expressId;
  const seen = new Set<number>([previous]);
  for (let i = 0; i < lane.length; i++) {
    const id = lane[i]!;
    if (id === previous) continue;
    previous = id;
    if (seen.has(id)) continue;
    seen.add(id);
    visit(id);
  }
}

export class TypeHiddenIndex {
  private source: readonly MeshFields[] | null = null;
  private scanned = 0;
  private readonly buckets = new Map<string, Bucket>();
  private settings: TypeHiddenSettings | null = null;
  private hidden = new Set<number>();
  private version = 0;
  private current: TypeHiddenIds = { ids: this.hidden, version: 0 };

  /**
   * Fold meshes appended since the last call (same array, grown) and apply
   * `settings`. A new array or a shorter one is indexed from scratch. Returns
   * the previous object when nothing changed.
   */
  update(meshes: readonly MeshFields[] | null | undefined, settings: TypeHiddenSettings): TypeHiddenIds {
    const list = meshes ?? [];
    let rebuild = this.settings === null || !sameSettings(this.settings, settings);
    if (this.source !== list || list.length < this.scanned) {
      this.source = list;
      this.scanned = 0;
      this.buckets.clear();
      rebuild = true;
    }
    this.settings = settings;
    const added: number[] = [];
    for (let i = this.scanned; i < list.length; i++) {
      const mesh = list[i]!;
      const bucket = this.bucketFor(mesh);
      meshIds(mesh, (id) => {
        this.push(bucket, id);
        if (!rebuild && !this.entityVisible(bucket, id, settings) && !this.hidden.has(id)) added.push(id);
      });
    }
    let grew = false;
    if (added.length > 0) {
      // Copy on write: the previous Set stays as it was for whoever holds it.
      this.hidden = new Set(this.hidden);
      for (const id of added) this.hidden.add(id);
      grew = true;
    }
    this.scanned = list.length;
    if (rebuild) {
      this.hidden = this.collect(settings);
      grew = true;
    }
    if (grew) {
      this.version++;
      this.current = { ids: this.hidden, version: this.version };
    }
    return this.current;
  }

  private bucketFor(mesh: MeshFields): Bucket {
    const geometryClass = mesh.geometryClass ?? 0;
    const key = `${geometryClass}\u0000${mesh.ifcType ?? ''}`;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { geometryClass, ifcType: mesh.ifcType || undefined, ids: new Float64Array(16), length: 0 };
      this.buckets.set(key, bucket);
    }
    return bucket;
  }

  private push(bucket: Bucket, id: number): void {
    // Meshes of one entity arrive together, so a repeat is usually the last id.
    if (bucket.length > 0 && bucket.ids[bucket.length - 1] === id) return;
    if (bucket.length === bucket.ids.length) {
      const grown = new Float64Array(bucket.ids.length * 2);
      grown.set(bucket.ids);
      bucket.ids = grown;
    }
    bucket.ids[bucket.length++] = id;
  }

  private entityVisible(bucket: Bucket, id: number, s: TypeHiddenSettings): boolean {
    if (!isMeshVisibleInViewMode(bucket.geometryClass, s.viewMode, s.hasOccurrenceGeometry)) return false;
    return isTypeVisible(s.retyped?.get(id) ?? bucket.ifcType, s.typeVisibility, s.structuralViewMode);
  }

  private collect(s: TypeHiddenSettings): Set<number> {
    const hidden = new Set<number>();
    const perId = (s.retyped?.size ?? 0) > 0;
    for (const bucket of this.buckets.values()) {
      const inView = isMeshVisibleInViewMode(bucket.geometryClass, s.viewMode, s.hasOccurrenceGeometry);
      const classVisible = isTypeVisible(bucket.ifcType, s.typeVisibility, s.structuralViewMode);
      if (inView && classVisible && !perId) continue;
      for (let i = 0; i < bucket.length; i++) {
        const id = bucket.ids[i]!;
        if (!inView || (perId ? !this.entityVisible(bucket, id, s) : !classVisible)) hidden.add(id);
      }
    }
    return hidden;
  }
}

/**
 * `hidden` with the type-hidden ids folded in: the set the viewport draws,
 * picks and frames by. `hidden` itself when type visibility hides nothing, so
 * the user's set is never written.
 */
export function withTypeHidden(hidden: Set<number>, typeHidden: TypeHiddenIds | null | undefined): Set<number> {
  const extra = typeHidden?.ids;
  if (!extra || extra.size === 0) return hidden;
  if (hidden.size === 0) return extra;
  const out = new Set(hidden);
  for (const id of extra) out.add(id);
  return out;
}
