/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Model slots: how one room carries several models (#4444).
 *
 * A room used to hold exactly one model, and every entity was keyed by its
 * IFC `GlobalId` alone (`/<GlobalId>`). Two loaded copies of the same file —
 * a legitimate workspace: the same building with two appearance sources
 * applied — therefore could not both be shared: `createEntity` is idempotent
 * on the path, so the second copy silently merged into the first and its
 * meshes were appended to the first copy's `geometryRef`.
 *
 * A slot is the room's name for one shared model. Slot ids are minted per
 * seed in share order (`m0`, `m1`, …) and never derived from a filename,
 * source bytes or a GlobalId, so identical inputs still get distinct slots.
 * Entity paths are qualified by slot: `/<slotId>/<GlobalId>` for STEP seeds,
 * `/<slotId>` prepended to the file's own path for IFCX seeds (whose own
 * header / imports / schemas are recorded per slot too, see
 * `snapshot/slot-ifcx.ts`). `geometry` stays content-hash keyed, and
 * the `geometryRef` that points at it is per entity path, i.e. per slot:
 * byte-identical blobs would dedupe across copies, but STEP mesh blobs
 * encode the federation-global expressId, so two copies of one file carry
 * two blob sets.
 *
 * Known limit: an IFCX seed re-homes `children` / `inherits` references
 * under the slot but not path-valued ATTRIBUTES of a custom schema — the
 * runtime cannot tell those from strings, so they keep the file's
 * unqualified path (see `qualifyNode` in `snapshot/slot-ifcx.ts`).
 *
 * Rooms seeded before slots existed have an empty `models` map and
 * unqualified paths. They are read as ONE implicit slot whose path prefix is
 * empty (`legacyModelSlot`), so `slotPath` / `pathInSlot` reduce to the old
 * `/<GlobalId>` scheme and nothing on disk needs rewriting — a CRDT
 * migration that moved every entity to a new path would be a delete+create
 * that every client raced to perform on join.
 */

import type * as Y from 'yjs';
import { modelsMap, metaMap } from './schema.js';

/** The two things a path needs to know about a slot. */
export interface ModelSlotRef {
  slotId: string;
  /** `/<slotId>` for a real slot; `''` for the implicit legacy slot. */
  pathPrefix: string;
}

/** What the owner records about a shared model, stored under `models/<slotId>`. */
export interface ModelSlotRecord {
  /** Display name (the viewer's model name, usually the filename). */
  name: string;
  fileName?: string;
  /** Raw schema string as the source reported it (`IFC4`, `IFC2X3`, `IFC5`, …). */
  schemaVersion?: string;
  /** Seed order; also the slot's index. */
  order: number;
  /** Durable source identity when the owner has one (never used to key a slot). */
  sourceFingerprint?: string;
  /**
   * Content-addressed blob containing a complete portable STEP source for
   * this slot. Recipients may parse it to retain representation-level data
   * (for example IfcAnnotation symbolic geometry) that the root-only IFCX
   * collaboration snapshot cannot express.
   */
  stepSourceBlobHash?: string;
  /** Encoding of `stepSourceBlobHash`; absent records are plain STEP. */
  stepSourceFormat?: 'step' | 'ifczip';
}

export interface ModelSlot extends ModelSlotRef, ModelSlotRecord {
  /** True for the implicit single slot of a room seeded before `models` existed. */
  legacy: boolean;
}

/** Slot id of the implicit slot a pre-slot room is read as. */
export const LEGACY_MODEL_SLOT_ID = 'm0';

/** Mint the slot id for the `index`-th model of a seed (`m0`, `m1`, …). */
export function modelSlotId(index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`@ifc-lite/collab: invalid model slot index ${index}`);
  }
  return `m${index}`;
}

const SLOT_ID_RE = /^m\d+$/;
const SLOT_PATH_RE = /^\/(m\d+)\//;

/** A path-building reference for a real (non-legacy) slot. */
export function modelSlotRef(slotId: string): ModelSlotRef {
  if (!SLOT_ID_RE.test(slotId)) {
    throw new Error(`@ifc-lite/collab: invalid model slot id "${slotId}"`);
  }
  return { slotId, pathPrefix: `/${slotId}` };
}

/** The implicit single slot of a room whose `models` map is empty. */
export function legacyModelSlot(name = 'Shared model'): ModelSlot {
  return { slotId: LEGACY_MODEL_SLOT_ID, pathPrefix: '', name, order: 0, legacy: true };
}

/** Entity path for a GlobalId-keyed (STEP) entity in `slot`. */
export function slotPath(slot: ModelSlotRef, guid: string): string {
  return `${slot.pathPrefix}/${guid}`;
}

/**
 * Qualify a file-defined IFCX path with the slot. IFCX paths may or may not
 * carry a leading slash; the result always has the form `<prefix>/<rest>` so
 * `pathInSlot` recognises it, and the original spelling is kept verbatim
 * after the prefix (a legacy slot returns the path unchanged).
 */
export function prefixPathForSlot(slot: ModelSlotRef, path: string): string {
  if (slot.pathPrefix === '') return path;
  return path.startsWith('/') ? `${slot.pathPrefix}${path}` : `${slot.pathPrefix}/${path}`;
}

/** Whether an entity path belongs to `slot` (every path belongs to the legacy slot). */
export function pathInSlot(slot: ModelSlotRef, path: string): boolean {
  if (slot.pathPrefix === '') return true;
  return path.startsWith(`${slot.pathPrefix}/`);
}

/** The slot id a qualified path names, or `null` for an unqualified (legacy) path. */
export function slotIdOfPath(path: string): string | null {
  const m = SLOT_PATH_RE.exec(path);
  return m ? m[1] : null;
}

/** Record a slot in the doc. Idempotent on `slotId`: an existing record wins. */
export function createModelSlot(doc: Y.Doc, slotId: string, record: ModelSlotRecord): ModelSlot {
  const ref = modelSlotRef(slotId);
  const models = modelsMap(doc);
  const existing = readRecord(models.get(slotId));
  if (existing) return { ...ref, ...existing, legacy: false };
  const stored: ModelSlotRecord = { name: record.name, order: record.order };
  if (record.fileName !== undefined) stored.fileName = record.fileName;
  if (record.schemaVersion !== undefined) stored.schemaVersion = record.schemaVersion;
  if (record.sourceFingerprint !== undefined) stored.sourceFingerprint = record.sourceFingerprint;
  if (record.stepSourceBlobHash !== undefined) stored.stepSourceBlobHash = record.stepSourceBlobHash;
  if (record.stepSourceFormat !== undefined) stored.stepSourceFormat = record.stepSourceFormat;
  models.set(slotId, stored);
  return { ...ref, ...stored, legacy: false };
}

export function getModelSlot(doc: Y.Doc, slotId: string): ModelSlot | undefined {
  const record = readRecord(modelsMap(doc).get(slotId));
  if (!record || !SLOT_ID_RE.test(slotId)) return undefined;
  return { ...modelSlotRef(slotId), ...record, legacy: false };
}

/**
 * Every slot of the room, in seed order. A room with no `models` entries —
 * seeded before slots existed, or still empty — is one legacy slot named
 * after whatever the seed recorded (`meta.stepHeader.fileName` for a STEP
 * room), so a joiner of an old room reconstructs exactly what it did before.
 */
export function listModelSlots(doc: Y.Doc): ModelSlot[] {
  const models = modelsMap(doc);
  const out: ModelSlot[] = [];
  for (const [slotId, raw] of models.entries()) {
    const record = readRecord(raw);
    if (!record || !SLOT_ID_RE.test(slotId)) continue;
    out.push({ ...modelSlotRef(slotId), ...record, legacy: false });
  }
  if (out.length === 0) {
    const header = metaMap(doc).get('stepHeader') as { fileName?: unknown } | undefined;
    const fileName = typeof header?.fileName === 'string' && header.fileName ? header.fileName : undefined;
    return [legacyModelSlot(fileName)];
  }
  out.sort((a, b) => a.order - b.order || (a.slotId < b.slotId ? -1 : 1));
  return out;
}

function readRecord(raw: unknown): ModelSlotRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== 'string' || typeof r.order !== 'number') return null;
  const record: ModelSlotRecord = { name: r.name, order: r.order };
  if (typeof r.fileName === 'string') record.fileName = r.fileName;
  if (typeof r.schemaVersion === 'string') record.schemaVersion = r.schemaVersion;
  if (typeof r.sourceFingerprint === 'string') record.sourceFingerprint = r.sourceFingerprint;
  if (typeof r.stepSourceBlobHash === 'string' && /^[0-9a-f]{32}$/.test(r.stepSourceBlobHash)) {
    record.stepSourceBlobHash = r.stepSourceBlobHash;
  }
  if (r.stepSourceFormat === 'step' || r.stepSourceFormat === 'ifczip') {
    record.stepSourceFormat = r.stepSourceFormat;
  }
  return record;
}
