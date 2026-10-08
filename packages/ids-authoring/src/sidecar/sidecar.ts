/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `studio.json` sidecar (ADR-001): everything Studio-specific about an
 * IDS document — node ids and `StudioMeta` — persisted NEXT TO the IDS XML,
 * never inside it, so the XML stays standard.
 *
 * The node index is positional (it mirrors the document shape), so the
 * sidecar records a fingerprint of the IDS content it was written for.
 * `attachSidecar` stamps the ids back only when the XML still has that
 * fingerprint; when the XML was edited elsewhere it re-identifies nodes
 * against the previous document (`reidentify`), so comments and
 * provenance survive.
 */

import { parseIDS, type IDSDocument } from '@ifc-lite/ids';
import { fromIdsDocument } from '../document/from-ids.js';
import { verifyNodeIndex } from '../document/node-index.js';
import { STUDIO_SCHEMA_VERSION, type NodeIndex, type StudioDocument, type StudioMeta } from '../document/types.js';
import { reidentify, type ReidentifyReport } from '../match/reidentify.js';
import { fnv1a64, uuidv7, type Uuid } from '../uuid.js';

export const SIDECAR_FORMAT = 'ifc-lite.ids-studio.sidecar';
export const SIDECAR_FILENAME = 'studio.json';

export interface StudioSidecar {
  format: typeof SIDECAR_FORMAT;
  schemaVersion: typeof STUDIO_SCHEMA_VERSION;
  docId: Uuid;
  /** Fingerprint of the IDS content the node index was written for. */
  idsFingerprint: string;
  nodes: NodeIndex;
  meta: StudioMeta;
}

/** Canonical JSON: sorted keys, `undefined` dropped. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Fingerprint of IDS content, independent of node ids (specification and
 * requirement `id`s are positional after a parse and UUIDs inside Studio).
 */
export function fingerprintIds(ids: IDSDocument): string {
  const stripped = {
    ...ids,
    specifications: ids.specifications.map((s) => ({
      ...s,
      id: undefined,
      requirements: s.requirements.map((r) => ({ ...r, id: undefined })),
    })),
  };
  return fnv1a64(canonical(stripped)).toString(16).padStart(16, '0');
}

/**
 * Build the sidecar for `doc`. Pass the XML that will travel with it when
 * there is one: the fingerprint is then taken from what a reader will
 * parse, which is what `attachSidecar` compares against.
 */
export function createSidecar(doc: StudioDocument, xml?: string): StudioSidecar {
  let content = doc.ids;
  if (xml !== undefined) {
    content = parseIDS(xml);
    const shape = (d: IDSDocument) => d.specifications.map((s) => `${s.applicability.facets.length}/${s.requirements.length}`).join(',');
    if (shape(content) !== shape(doc.ids)) {
      throw new Error('the XML does not have the shape of the document; write it from this document');
    }
  }
  return {
    format: SIDECAR_FORMAT,
    schemaVersion: STUDIO_SCHEMA_VERSION,
    docId: doc.docId,
    idsFingerprint: fingerprintIds(content),
    nodes: doc.nodes,
    meta: doc.meta,
  };
}

/** Stable, human-diffable JSON (2-space indent, trailing newline). */
export function serializeSidecar(sidecar: StudioSidecar): string {
  return `${JSON.stringify(sidecar, null, 2)}\n`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Parse and validate `studio.json`. Throws on a foreign or newer format. */
export function parseSidecar(json: string): StudioSidecar {
  const value: unknown = JSON.parse(json);
  if (!isRecord(value) || value.format !== SIDECAR_FORMAT) throw new Error('not an IDS Studio sidecar');
  if (value.schemaVersion !== STUDIO_SCHEMA_VERSION) {
    throw new Error(`unsupported sidecar schemaVersion ${String(value.schemaVersion)}`);
  }
  if (typeof value.docId !== 'string' || typeof value.idsFingerprint !== 'string' || !isRecord(value.nodes) || !isRecord(value.meta)) {
    throw new Error('IDS Studio sidecar is incomplete');
  }
  return value as unknown as StudioSidecar;
}

/** Stamp node ids onto parsed content positionally; undefined if the shape differs. */
function stamp(ids: IDSDocument, sidecar: StudioSidecar): StudioDocument | undefined {
  const nodes = sidecar.nodes;
  if (nodes.specs.length !== ids.specifications.length) return undefined;
  const doc: StudioDocument = {
    docId: sidecar.docId,
    schemaVersion: STUDIO_SCHEMA_VERSION,
    ids: {
      ...ids,
      specifications: ids.specifications.map((s, i) => ({
        ...s,
        id: nodes.specs[i].id,
        requirements: s.requirements.map((r, j) => ({ ...r, id: nodes.specs[i].requirements[j]?.id ?? r.id })),
      })),
    },
    nodes,
    meta: sidecar.meta,
  };
  return verifyNodeIndex(doc).length === 0 ? doc : undefined;
}

export type AttachResult =
  | { doc: StudioDocument; binding: 'exact' }
  | { doc: StudioDocument; binding: 'reidentified'; report: ReidentifyReport }
  | { doc: StudioDocument; binding: 'fresh' };

export interface AttachOptions {
  newId?: () => Uuid;
  /**
   * The document as it was when the sidecar was written (e.g. from the
   * local library). When the XML changed elsewhere, its nodes are
   * re-identified against this instead of getting fresh ids.
   */
  previous?: StudioDocument;
}

/**
 * Rebuild a Studio document from parsed IDS content and its sidecar. When
 * the content still has the sidecar's fingerprint the node ids are reused
 * exactly. Otherwise, given the `previous` document, nodes are
 * re-identified (identifier → name + signature → similarity); without it
 * the document gets fresh ids. `docId` and `meta` are kept either way and
 * `binding` tells the caller which path was taken.
 */
export function attachSidecar(ids: IDSDocument, sidecar: StudioSidecar, options: AttachOptions = {}): AttachResult {
  const newId = options.newId ?? (() => uuidv7());
  if (fingerprintIds(ids) === sidecar.idsFingerprint) {
    const doc = stamp(ids, sidecar);
    if (doc) return { doc, binding: 'exact' };
  }
  if (options.previous) {
    const base: StudioDocument = { ...options.previous, docId: sidecar.docId, meta: sidecar.meta };
    const { doc, report } = reidentify(base, ids, { newId });
    return { doc, binding: 'reidentified', report };
  }
  return { doc: fromIdsDocument(ids, { docId: sidecar.docId, meta: sidecar.meta, newId }), binding: 'fresh' };
}
