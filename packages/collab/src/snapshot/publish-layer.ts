/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * publishLayer: freeze a draft into an immutable, content-addressed,
 * provenance-stamped layer.
 *
 * The draft is a CRDT session (Y.Doc) bound to a base; freezing extracts
 * the minimal layer (including deletion overlays), attaches the
 * provenance manifest (intent, author, scope claims, base, checks), and
 * content-addresses the result: `layerId = blake3(canonical_bytes)`.
 *
 * Check execution and scope-claim verification happen at the calling
 * boundary (MCP/CLI/registry) — pass the results in; they are recorded
 * in the manifest, and signatures never participate in the id.
 *
 * Spec: docs/architecture/layer-prs/02-layer-format.md §2.4,
 *       03-provenance.md, 06-agents.md §6.2.
 */

import type {
  IfcxFile,
  ProvenanceAuthor,
  ProvenanceBase,
  ProvenanceCheck,
  ProvenanceManifest,
} from '@ifc-lite/ifcx';
import { computeLayerId, createProvenanceManifest, setProvenance } from '@ifc-lite/ifcx';
import type * as Y from 'yjs';
import { extractMinimalLayer, type ExtractMinimalLayerOptions } from './minimal-layer.js';

export interface PublishLayerOptions {
  /** Human-readable why. Mandatory — the `ifc layer log` line. */
  intent: string;
  /** Who authored the draft (human / agent / hybrid). */
  author: ProvenanceAuthor;
  /**
   * Baseline the draft was forked from
   * (`Y.encodeStateAsUpdate` / `captureBaseline` output).
   */
  baseline: Uint8Array;
  /** Identity of the base layer/stack the draft was authored against. */
  base?: ProvenanceBase | null;
  /** Capability-grammar scope claims declared for this layer. */
  scope_claim?: string[];
  /** Results of declared checks, run by the caller before publishing. */
  checks?: ProvenanceCheck[];
  /** blake3 digest of the prompt/task text that produced the layer. */
  instructions_digest?: string;
  /** Parent layer ids in the change DAG (defaults to the base id). */
  parents?: string[];
  /** Manifest timestamp override (defaults to now). */
  created?: string;
  /** Forwarded to the minimal-layer extractor. */
  extract?: ExtractMinimalLayerOptions;
}

export interface PublishedLayer {
  /** The immutable layer document, `header.id` set to the content address. */
  file: IfcxFile;
  /** `blake3:` content address over canonical bytes. */
  layerId: string;
  manifest: ProvenanceManifest;
  /** Number of changed nodes the layer carries. */
  opCount: number;
}

/**
 * Freeze a draft doc into a published layer. Pure with respect to the
 * draft: the Y.Doc is read, never mutated — publishing again after more
 * edits produces a new layer with a new id.
 */
export function publishLayer(doc: Y.Doc, options: PublishLayerOptions): PublishedLayer {
  const delta = extractMinimalLayer(doc, options.baseline, options.extract);

  const manifest = createProvenanceManifest({
    author: options.author,
    intent: options.intent,
    base: options.base ?? null,
    created: options.created,
    parents: options.parents ?? (options.base ? [options.base.id] : []),
    scope_claim: options.scope_claim ?? [],
    checks: options.checks ?? [],
    instructions_digest: options.instructions_digest,
  });

  // Normalize the generated snapshot header to the publish event so the
  // content address is a function of content + manifest, not of when the
  // snapshot writer happened to run.
  const normalized: IfcxFile = {
    ...delta,
    header: {
      ...delta.header,
      author: options.author.principal,
      timestamp: manifest.created,
    },
  };
  const withManifest = setProvenance(normalized, manifest);
  const layerId = computeLayerId(withManifest);

  return {
    file: { ...withManifest, header: { ...withManifest.header, id: layerId } },
    layerId,
    manifest,
    opCount: delta.data.length,
  };
}
