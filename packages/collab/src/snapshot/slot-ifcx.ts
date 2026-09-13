/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * How an IFCX file is re-homed under a model slot (#4444): its nodes and its
 * file-level metadata.
 *
 * Nodes: `qualifyNode` prefixes a node's path and every path-valued
 * `children` / `inherits` reference with the slot (`/<slotId>` + the file's
 * own path), so the file's path scheme survives verbatim underneath it.
 *
 * Metadata: a room used to hold one file, so `seedFromIfcx` stashed its
 * header / imports / schemas under the room-wide `meta.header` /
 * `meta.imports` / `meta.schemas` and the snapshot re-emitted them. With one
 * file per slot that is a race: the second IFC5 model's seed overwrote the
 * first's, and a per-slot snapshot handed slot m0's recipient slot m1's
 * schemas. Each real slot therefore records its file metadata under its own
 * key, `ifcxFile:<slotId>`; the implicit legacy slot (and a slot-less seed)
 * keeps the room-wide keys so rooms shared before slots existed read exactly
 * as they did. A whole-room snapshot of a multi-slot room merges: imports
 * concatenated in slot order, schemas spread in slot order (a later slot's
 * same-named schema wins — two copies of one file carry identical
 * definitions), header from the first slot that recorded one.
 */

import type * as Y from 'yjs';
import type { IfcxFile, IfcxHeader, IfcxNode, ImportNode } from '@ifc-lite/ifcx';
import { prefixPathForSlot, type ModelSlotRef } from '../doc/model-slot.js';

/**
 * Re-home a node under a slot: its own path plus every path-valued
 * `children` / `inherits` reference (a `null` removal opinion stays `null`).
 *
 * Attribute values are opaque here: the runtime does not know which
 * attributes of a custom schema are path-typed, so an attribute whose VALUE
 * names another node's path is stored verbatim and dangles on a recipient
 * (it points at the unqualified path, which no slot holds). `children` and
 * `inherits` are the only references IFCX composition itself resolves, and
 * the only ones the viewer's ingest follows. Geometry carriers are
 * content-hash keyed and slot-independent.
 */
export function qualifyNode(slot: ModelSlotRef, node: IfcxNode): IfcxNode {
  const raw = node as { path?: string; children?: Record<string, unknown>; inherits?: Record<string, unknown> };
  if (!raw.path) return node;
  const qualifyRefs = (refs: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
    if (!refs) return refs;
    const out: Record<string, unknown> = {};
    for (const [role, target] of Object.entries(refs)) {
      out[role] = typeof target === 'string' ? prefixPathForSlot(slot, target) : target;
    }
    return out;
  };
  return {
    ...node,
    path: prefixPathForSlot(slot, raw.path),
    children: qualifyRefs(raw.children),
    inherits: qualifyRefs(raw.inherits),
  } as IfcxNode;
}

/** The file-level fields a snapshot re-emits. */
export interface IfcxFileMeta {
  header?: IfcxHeader;
  imports?: ImportNode[];
  schemas?: Record<string, unknown>;
}

const SLOT_FILE_META_PREFIX = 'ifcxFile:';

function slotFileMetaKey(slot: ModelSlotRef): string {
  return `${SLOT_FILE_META_PREFIX}${slot.slotId}`;
}

function isRealSlot(slot: ModelSlotRef | undefined): slot is ModelSlotRef {
  return slot !== undefined && slot.pathPrefix !== '';
}

function readRecord(raw: unknown): IfcxFileMeta {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const out: IfcxFileMeta = {};
  if (r.header && typeof r.header === 'object') out.header = r.header as IfcxHeader;
  if (Array.isArray(r.imports)) out.imports = r.imports as ImportNode[];
  if (r.schemas && typeof r.schemas === 'object') out.schemas = r.schemas as Record<string, unknown>;
  return out;
}

/** Record `file`'s header / imports / schemas for `slot` (room-wide when no real slot). */
export function writeIfcxFileMeta(meta: Y.Map<unknown>, slot: ModelSlotRef | undefined, file: IfcxFile): void {
  if (!isRealSlot(slot)) {
    if (file.header) meta.set('header', file.header);
    if (file.imports) meta.set('imports', file.imports);
    if (file.schemas) meta.set('schemas', file.schemas);
    return;
  }
  const record: IfcxFileMeta = {};
  if (file.header) record.header = file.header;
  if (file.imports) record.imports = file.imports;
  if (file.schemas) record.schemas = file.schemas as Record<string, unknown>;
  meta.set(slotFileMetaKey(slot), record);
}

/** Slot ids that recorded file metadata, in slot order (`m0`, `m1`, …). */
function recordedSlotIds(meta: Y.Map<unknown>): string[] {
  const ids: string[] = [];
  for (const key of meta.keys()) {
    if (key.startsWith(SLOT_FILE_META_PREFIX)) ids.push(key.slice(SLOT_FILE_META_PREFIX.length));
  }
  const index = (id: string): number => Number.parseInt(id.slice(1), 10);
  return ids.sort((a, b) => index(a) - index(b) || a.localeCompare(b));
}

/**
 * The file metadata a snapshot of `slot` re-emits; of the whole room when no
 * slot is named. Falls back to the room-wide keys where nothing per-slot was
 * recorded (a legacy room, or a slot seeded from STEP, which has no IFCX file).
 */
export function readIfcxFileMeta(meta: Y.Map<unknown>, slot: ModelSlotRef | undefined): IfcxFileMeta {
  const roomWide: IfcxFileMeta = readRecord({
    header: meta.get('header'),
    imports: meta.get('imports'),
    schemas: meta.get('schemas'),
  });
  if (isRealSlot(slot)) {
    const own = readRecord(meta.get(slotFileMetaKey(slot)));
    return { ...roomWide, ...own };
  }
  const merged: IfcxFileMeta = { ...roomWide };
  for (const slotId of recordedSlotIds(meta)) {
    const own = readRecord(meta.get(`${SLOT_FILE_META_PREFIX}${slotId}`));
    if (own.header && !merged.header) merged.header = own.header;
    if (own.imports) merged.imports = [...(merged.imports ?? []), ...own.imports];
    if (own.schemas) merged.schemas = { ...merged.schemas, ...own.schemas };
  }
  return merged;
}
