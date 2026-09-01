/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IFCX → Y.Doc seeding.
 *
 * Idempotent: seeding the same buffer into a fresh Y.Doc twice produces
 * the same state. Used both at session start and when resetting from a
 * snapshot.
 */

import type { IfcxFile, IfcxNode } from '@ifc-lite/ifcx';
import { IFCLITE_ATTR } from '@ifc-lite/ifcx';
import * as Y from 'yjs';
import {
  createEntity,
  deleteAttribute,
  deleteEntity,
  getEntity,
  hasEntity,
  removeChild,
  removeInherit,
  setAttribute,
  setChild,
  setGeometryRef,
  setInherit,
  setPropertyValue,
  setQuantityValue,
} from '../doc/entity.js';
import { createGeometry, upsertGeometry, type GeometryType } from '../doc/geometry.js';
import {
  ENTITY_KEY,
  SEED_ORIGIN,
  assertSchemaInvariants,
  metaMap,
} from '../doc/schema.js';
import { inflateStructuredAttributes } from './structured-attrs.js';
import { clearOverlayTombstones, readOverlayTombstones, resolveTombstoneOpinion, resurrectionBlocked, writeOverlayTombstones } from './overlay-tombstones.js';
import { setClassifications, setMaterials, readIfcClass } from './overlay-entity-attrs.js';

export interface SeedOptions {
  /** Origin tag for the seeding transaction. Defaults to SEED_ORIGIN. */
  origin?: unknown;
  /** If true, clear any existing top-level state before seeding. */
  reset?: boolean;
}

export type IfcxInput = ArrayBuffer | Uint8Array | string | IfcxFile;

/** Decode whatever the caller hands us into a parsed IfcxFile. */
export function parseIfcxInput(input: IfcxInput): IfcxFile {
  if (typeof input === 'string') {
    return JSON.parse(input) as IfcxFile;
  }
  if (input instanceof ArrayBuffer) {
    const text = new TextDecoder().decode(new Uint8Array(input));
    return JSON.parse(text) as IfcxFile;
  }
  if (input instanceof Uint8Array) {
    const text = new TextDecoder().decode(input);
    return JSON.parse(text) as IfcxFile;
  }
  return input;
}

/**
 * Seed `doc` with the contents of an IFCX file. Returns the parsed file
 * for callers that want to inspect headers / schemas.
 */
export function seedFromIfcx(doc: Y.Doc, input: IfcxInput, opts: SeedOptions = {}): IfcxFile {
  const file = parseIfcxInput(input);
  assertSchemaInvariants(doc);

  doc.transact(() => {
    const meta = metaMap(doc);
    if (opts.reset) {
      const ents = doc.getMap('entities');
      const rels = doc.getMap('relationships');
      const geom = doc.getMap('geometry');
      ents.clear();
      rels.clear();
      geom.clear();
      // Overlay tombstones describe deletions in the discarded entity
      // universe; retaining them would block a same-path entity in this
      // freshly seeded snapshot.
      clearOverlayTombstones(meta);
    }

    // Stash file-level metadata so we can re-emit it during snapshotting.
    if (file.header) meta.set('header', file.header);
    if (file.imports) meta.set('imports', file.imports);
    if (file.schemas) meta.set('schemas', file.schemas);

    for (const node of file.data ?? []) {
      const decoded = decodeNode(node, false);
      if (!decoded) continue;
      restoreGeometryCarriers(doc, decoded, createGeometry);
      createNodeEntity(doc, decoded);
    }
  }, opts.origin ?? SEED_ORIGIN);

  return file;
}

/* ------------------------------------------------------------------ */
/* Node decoding — shared by the seeder and the overlay applier         */
/* ------------------------------------------------------------------ */

interface DecodedNode {
  path: string;
  ifcClass?: string;
  inflated: ReturnType<typeof inflateStructuredAttributes>;
  children: Record<string, string>;
  inherits: Record<string, string>;
  /** The node's `ifclite::deleted` opinion, if it carries one. */
  tombstone?: boolean;
  /** Roles/keys the node explicitly nulls out — IFCX removal opinions. */
  removedAttributes: string[];
  removedChildren: string[];
  removedInherits: string[];
}

interface RawIfcxNode {
  path?: string;
  attributes?: Record<string, unknown>;
  children?: Record<string, unknown>;
  inherits?: Record<string, unknown>;
}

/**
 * `stripTombstone` splits the two readers apart. The overlay applier
 * acts on `ifclite::deleted` and must not leave the marker behind as an
 * ordinary attribute (the same reason `bakeLayers` strips it from
 * survivors). `seedFromIfcx` has never interpreted it and must keep
 * storing it verbatim: it seeds live session docs in `apps/viewer` and
 * `snapshot/worker.ts`, and quietly dropping an attribute there would be
 * a behaviour change on a far more common path than this fix touches.
 */
function decodeNode(node: IfcxNode, stripTombstone: boolean): DecodedNode | undefined {
  const rawNode = node as RawIfcxNode;
  const path = rawNode.path;
  if (!path) return undefined;

  // Null attribute values are removal opinions (minimal layers); with
  // nothing beneath them to remove, they mean "absent" — never store
  // them as values.
  const rawAttributes: Record<string, unknown> = {};
  const removedAttributes: string[] = [];
  let tombstone: boolean | undefined;
  for (const [key, value] of Object.entries(rawNode.attributes ?? {})) {
    if (key === IFCLITE_ATTR.DELETED) {
      if (typeof value === 'boolean') tombstone = value;
      if (stripTombstone) continue;
    }
    if (value === null) removedAttributes.push(key);
    else rawAttributes[key] = value;
  }
  // Re-inflate structured branches the snapshot writer folded into
  // namespaced attributes (#1031); the shape-gated remainder stays
  // in the flat attributes branch.
  const inflated = inflateStructuredAttributes(rawAttributes);

  const children: Record<string, string> = {};
  const removedChildren: string[] = [];
  for (const [role, target] of Object.entries(rawNode.children ?? {})) {
    if (typeof target === 'string') children[role] = target;
    else if (target === null) removedChildren.push(role);
  }
  const inherits: Record<string, string> = {};
  const removedInherits: string[] = [];
  for (const [role, target] of Object.entries(rawNode.inherits ?? {})) {
    if (typeof target === 'string') inherits[role] = target;
    else if (target === null) removedInherits.push(role);
  }

  return {
    path,
    ifcClass: readIfcClass(rawNode.attributes),
    inflated,
    children,
    inherits,
    tombstone,
    removedAttributes,
    removedChildren,
    removedInherits,
  };
}

/**
 * A carrier with the embedded geometry record recreates the geometry map
 * entry, so the restored ref is never dangling. Bare-id carriers keep
 * pointing at out-of-band hydrated geometry.
 */
function restoreGeometryCarriers(
  doc: Y.Doc,
  decoded: DecodedNode,
  write: typeof createGeometry,
): void {
  for (const carrier of decoded.inflated.geometryCarriers) {
    if (typeof carrier.type !== 'string' || typeof carrier.source !== 'string') continue;
    write(doc, carrier.geomId, {
      type: carrier.type as GeometryType,
      source: carrier.source,
      blobHash: carrier.blobHash,
      params: carrier.params,
      bbox: carrier.bbox as [number, number, number, number, number, number] | undefined,
    });
  }
}

function createNodeEntity(doc: Y.Doc, decoded: DecodedNode): void {
  const { ifcClass, inflated } = decoded;
  createEntity(doc, decoded.path, {
    ifcClass,
    attributes: inflated.attributes,
    children: decoded.children,
    inherits: decoded.inherits,
    psets: inflated.psets,
    quantities: inflated.quantities,
    classifications: inflated.classifications,
    materials: inflated.materials,
    geometryRef: inflated.geometryRefRecord,
    // Provenance comes from the node's own `ifclite::meta` carrier and
    // from nowhere else (#3092). The file header describes the FILE, and a
    // snapshot of a collab doc puts the snapshotter's own name and write
    // clock there; copying that onto every node fabricated a `createdBy`/
    // `createdAt` indistinguishable from real attribution. Absent reads as
    // "unknown"; invented gets trusted.
    stampCreatedAt: false,
    meta: {
      ifcClass,
      schemaVersion: 'ifc5',
      ...inflated.meta,
    },
  });
}

/* ------------------------------------------------------------------ */
/* Overlay application                                                  */
/* ------------------------------------------------------------------ */

export interface OverlayOptions {
  /** Origin tag for the overlay transaction. Defaults to SEED_ORIGIN. */
  origin?: unknown;
}

/**
 * Apply an IFCX file to `doc` as a *layer of opinions* rather than as a
 * seed.
 *
 * `seedFromIfcx` routes every node through `createEntity`, a deliberate
 * no-op on a path the doc already has — right for seeding from a
 * snapshot, wrong for merging a layer whose purpose is to modify entities
 * that already exist. This applier creates missing entities exactly as
 * the seeder does, and writes existing entities' opinions on top: values
 * overwrite, anything unmentioned is left alone. `null` removes a FLAT
 * attribute, child or inherit ONLY: a nulled pset/quantity property
 * survives, silently (pinned in `test/apply-ifcx-overlay.test.ts`).
 *
 * Deliberately NOT part of `seedFromIfcx`'s option surface: the seeder is
 * additive-and-idempotent (`apps/viewer`, `snapshot/worker.ts` seed a
 * live session doc with it), and this is a different operation.
 *
 * Deletion opinions are honoured where the layer states them: an
 * `ifclite::deleted: true` node removes the entity, matching composition,
 * `bakeLayers` and the MCP layer store. A full IFCX snapshot emits only
 * what an entity has though, so a key or entity deleted in the source doc
 * is simply absent rather than nulled or tombstoned, and an overlay
 * cannot tell that apart from "no opinion" — deletions propagate only
 * from layers that state them explicitly. Across separate calls, a path
 * this function itself deleted stays deleted regardless: see
 * `overlay-tombstones.ts`.
 */
export function applyIfcxOverlay(
  doc: Y.Doc,
  input: IfcxInput,
  opts: OverlayOptions = {},
): IfcxFile {
  const file = parseIfcxInput(input);
  assertSchemaInvariants(doc);

  doc.transact(() => {
    const meta = metaMap(doc);
    if (file.header) meta.set('header', file.header);
    if (file.imports) meta.set('imports', file.imports);
    if (file.schemas) meta.set('schemas', file.schemas);

    const tombstonesFromEarlierCalls = readOverlayTombstones(meta);

    // Composition resolves `ifclite::deleted` after every node in the
    // layer has been applied — the strongest (last) opinion wins — so a
    // base → delete → resurrect sequence within one file must seed the
    // entity's state first and only then act on the final verdict.
    const tombstoned = new Map<string, boolean>();
    for (const node of file.data ?? []) {
      const decoded = decodeNode(node, true);
      if (!decoded) continue;
      const opinion = decoded.tombstone;
      if (opinion !== undefined) tombstoned.set(decoded.path, opinion);
      restoreGeometryCarriers(doc, decoded, upsertGeometry);
      if (!hasEntity(doc, decoded.path)) {
        if (resurrectionBlocked(tombstonesFromEarlierCalls, decoded.path, opinion)) continue;
        createNodeEntity(doc, decoded);
        continue;
      }
      overlayEntity(doc, decoded);
    }
    for (const [path, deleted] of tombstoned) {
      if (deleted) deleteEntity(doc, path);
      resolveTombstoneOpinion(tombstonesFromEarlierCalls, path, deleted);
    }
    writeOverlayTombstones(meta, tombstonesFromEarlierCalls);
  }, opts.origin ?? SEED_ORIGIN);

  return file;
}

function overlayEntity(doc: Y.Doc, decoded: DecodedNode): void {
  const { path, inflated } = decoded;

  for (const [key, value] of Object.entries(inflated.attributes)) {
    setAttribute(doc, path, key, value);
  }
  for (const key of decoded.removedAttributes) deleteAttribute(doc, path, key);

  for (const [role, target] of Object.entries(decoded.children)) {
    setChild(doc, path, role, target);
  }
  for (const role of decoded.removedChildren) removeChild(doc, path, role);

  for (const [role, target] of Object.entries(decoded.inherits)) {
    setInherit(doc, path, role, target);
  }
  for (const role of decoded.removedInherits) removeInherit(doc, path, role);

  for (const [psetName, props] of Object.entries(inflated.psets)) {
    for (const [propName, value] of Object.entries(props)) {
      setPropertyValue(doc, path, psetName, propName, value);
    }
  }
  for (const [qsetName, qtys] of Object.entries(inflated.quantities)) {
    for (const [qtyName, value] of Object.entries(qtys)) {
      setQuantityValue(doc, path, qsetName, qtyName, value);
    }
  }

  // Lists are single-valued opinions: a node that carries one replaces
  // the doc's list wholesale, a node that carries none says nothing and
  // must leave the doc's list untouched.
  if (inflated.classifications.length > 0) {
    setClassifications(doc, path, inflated.classifications);
  }
  if (inflated.materials.length > 0) {
    setMaterials(doc, path, inflated.materials);
  }
  if (inflated.geometryRefRecord && inflated.geometryRefRecord.geomIds.length > 0) {
    setGeometryRef(doc, path, inflated.geometryRefRecord);
  }

  // `meta.ifcClass` mirrors the class attribute; keep the two in step.
  if (decoded.ifcClass) {
    const entityMeta = getEntity(doc, path)?.get(ENTITY_KEY.META) as Y.Map<unknown> | undefined;
    entityMeta?.set('ifcClass', decoded.ifcClass);
  }
}
