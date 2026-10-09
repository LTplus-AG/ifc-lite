/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reading IDS for headless callers (CLI, MCP, SDK, Flow).
 *
 * Headless callers are stateless: the same XML read twice must give the
 * same node ids, or an agent that reads a document, then refers to a node
 * id in its next tool call, addresses nothing. Node ids are therefore
 * derived from the content fingerprint instead of minted from the clock.
 */

import { parseIDS, type IDSDocument } from '@ifc-lite/ids';
import { fromIdsDocument } from '../document/from-ids.js';
import { verifyNodeIndex } from '../document/node-index.js';
import type { StudioDocument } from '../document/types.js';
import { fingerprintIds } from '../sidecar/sidecar.js';
import { deriveId, isUuid } from '../uuid.js';

/** Wrap a parsed IDS with node ids that depend only on its content. */
export function studioDocumentFromIds(ids: IDSDocument): StudioDocument {
  const seed = fingerprintIds(ids);
  let n = 0;
  return fromIdsDocument(ids, { newId: () => deriveId(seed, `node:${n++}`) });
}

/**
 * Parse IDS XML into a `StudioDocument` with deterministic node ids.
 * Throws the parser's `IDSParseError` on malformed input.
 */
export function readStudioDocument(xml: string): StudioDocument {
  return studioDocumentFromIds(parseIDS(xml));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Accept a `StudioDocument` that crossed a process boundary (an MCP tool
 * argument, a Flow port, a file). Throws an `Error` naming the first
 * problem. This checks the shape and the node index only: content written
 * into the JSON by hand never passed the grounding gate, which is why
 * `writeStudioDocument` audits what it serialises.
 */
export function parseStudioDocument(value: unknown): StudioDocument {
  if (!isRecord(value)) throw new Error('a Studio document must be a JSON object');
  if (value.schemaVersion !== 1) throw new Error(`unsupported Studio document schemaVersion ${String(value.schemaVersion)}`);
  if (!isUuid(value.docId)) throw new Error('docId must be a UUID');
  const ids = value.ids;
  if (!isRecord(ids) || !isRecord(ids.info) || !Array.isArray(ids.specifications)) {
    throw new Error('ids must hold info and specifications');
  }
  const nodes = value.nodes;
  if (!isRecord(nodes) || !isUuid(nodes.document) || !Array.isArray(nodes.specs)) {
    throw new Error('nodes must hold the document id and one entry per specification');
  }
  if (!isRecord(value.meta)) throw new Error('meta must be an object');
  for (const [i, spec] of ids.specifications.entries()) {
    if (!isRecord(spec) || !isRecord(spec.applicability) || !Array.isArray(spec.applicability.facets) || !Array.isArray(spec.requirements)) {
      throw new Error(`specification ${i} must hold applicability.facets and requirements`);
    }
    const facets = [...spec.applicability.facets, ...spec.requirements.map((r) => (isRecord(r) ? r.facet : r))];
    if (!facets.every((f) => isRecord(f) && typeof f.type === 'string')) {
      throw new Error(`specification ${i} holds a facet without a type`);
    }
  }
  for (const [i, sn] of nodes.specs.entries()) {
    if (!isRecord(sn) || !Array.isArray(sn.applicability) || !Array.isArray(sn.requirements)) {
      throw new Error(`nodes.specs[${i}] must hold applicability and requirements`);
    }
  }
  // The checks above establish every field `verifyNodeIndex` reads.
  const doc = value as unknown as StudioDocument;
  const problems = verifyNodeIndex(doc);
  if (problems.length > 0) throw new Error(`inconsistent node index: ${problems[0]}`);
  return doc;
}
