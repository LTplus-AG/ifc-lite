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
 * An adopted scene snapshot draws before its meshes decode, so the snapshot
 * carries the same buckets as compact metadata (`exportMetadata`), and
 * `fromMetadata` answers for the current settings until the meshes arrive.
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
import { GEOM_CLASS_OCCURRENCE, isPlacedGeometryClass } from '@ifc-lite/geometry/geometry-class';

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

/** The index's buckets as JSON, stored beside a scene snapshot: [geometry class, IFC class, entity ids]. */
export interface TypeIndexMetadata {
  v: 1;
  buckets: Array<[geometryClass: number, ifcType: string, ids: number[]]>;
}

function isMetadata(value: unknown): value is TypeIndexMetadata {
  const m = value as TypeIndexMetadata | null | undefined;
  return m?.v === 1 && Array.isArray(m.buckets) && m.buckets.every((b) => Array.isArray(b) && b.length === 3
    && Number.isInteger(b[0]) && typeof b[1] === 'string' && Array.isArray(b[2]) && b[2].every(Number.isFinite));
}

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

  /** The buckets of `meshes`, for a scene snapshot to carry. */
  static metadataOf(meshes: readonly MeshFields[]): TypeIndexMetadata {
    const index = new TypeHiddenIndex();
    for (const mesh of meshes) index.ingest(mesh, () => {});
    return { v: 1, buckets: [...index.buckets.values()].map((b) => [b.geometryClass, b.ifcType ?? '', Array.from(b.ids.subarray(0, b.length))]) };
  }

  /** An index over a snapshot's stored buckets; null when the metadata is missing or malformed. */
  static fromMetadata(value: unknown): TypeHiddenIndex | null {
    if (!isMetadata(value)) return null;
    const index = new TypeHiddenIndex();
    for (const [geometryClass, ifcType, ids] of value.buckets) {
      const bucket = index.bucketFor({ expressId: 0, geometryClass, ifcType: ifcType || undefined });
      for (const id of ids) index.push(bucket, id);
    }
    return index;
  }

  /** What the viewport's mesh scans answer: any placed geometry (occurrence or layer slice), any non-occurrence geometry. */
  holds(kind: 'placed' | 'nonOccurrence'): boolean {
    for (const b of this.buckets.values()) {
      if (kind === 'placed' ? isPlacedGeometryClass(b.geometryClass) : b.geometryClass !== GEOM_CLASS_OCCURRENCE) return true;
    }
    return false;
  }

  /** The hidden ids over the indexed buckets under `settings`, without a mesh list. */
  hiddenFor(settings: TypeHiddenSettings): TypeHiddenIds {
    if (this.settings === null || !sameSettings(this.settings, settings)) {
      this.settings = settings;
      this.hidden = this.collect(settings);
      this.current = { ids: this.hidden, version: ++this.version };
    }
    return this.current;
  }

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
      this.ingest(list[i]!, (bucket, id) => {
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

  private ingest(mesh: MeshFields, onId: (bucket: Bucket, id: number) => void): void {
    const bucket = this.bucketFor(mesh);
    meshIds(mesh, (id) => { this.push(bucket, id); onId(bucket, id); });
  }

  private bucketFor(mesh: Pick<MeshFields, 'expressId' | 'ifcType' | 'geometryClass'>): Bucket {
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
