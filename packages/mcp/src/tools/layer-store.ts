/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * In-memory draft / layer / review workspace backing the agent draft-layer
 * tool family (docs/architecture/layer-prs/06-agents.md).
 *
 * Drafts are keyed by transport session id (#1030) and disposed with the
 * session; published layers, refs, and reviews are process-shared so
 * other principals' sessions can build on and review them. Tests call
 * `resetLayerWorkspace()` for isolation. A draft is a CRDT session (Y.Doc
 * seeded with the resolved base stack) plus the baseline snapshot
 * `publishLayer` diffs against.
 */

import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import {
  createCollabDoc,
  createEntity,
  deleteAttribute,
  deleteEntity,
  hasEntity,
  removeChild,
  removeInherit,
  setAttribute,
  setChild,
  setInherit,
} from '@ifc-lite/collab';
import type { ScopeClaim } from '@ifc-lite/extensions';
import { IFCLITE_ATTR, ATTR, computeStackHash } from '@ifc-lite/ifcx';
import type { IfcxFile, ProvenanceBase } from '@ifc-lite/ifcx';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';

export interface DraftLayer {
  id: string;
  doc: Y.Doc;
  /** `Y.encodeStateAsUpdate(doc)` at creation — what `publishLayer` diffs against. */
  baseline: Uint8Array;
  base: ProvenanceBase | null;
  /** Resolved base stack (weakest first) for merge previews; may be []. */
  baseFiles: IfcxFile[];
  intent: string;
  claims: ScopeClaim[];
  rawClaims: string[];
  session: string;
  /** Creating principal; undefined = unauthenticated/local → accessible to anyone in the workspace. */
  owner?: string;
  createdAt: string;
}

export interface ReviewDecision {
  entity: string;
  componentKey?: string;
  decision: 'accept' | 'reject';
  comment?: string;
}

export type ReviewStatus = 'open' | 'changes-requested' | 'approved';

export interface LayerReview {
  id: string;
  layerId: string;
  into: string;
  reviewers: string[];
  status: ReviewStatus;
  feedback: ReviewDecision[];
  /** Follow-up draft ids opened via `respond_to_review`. */
  responses: string[];
  /** Requesting principal; undefined = unauthenticated/local → accessible to anyone in the workspace. */
  owner?: string;
}

export interface LayerWorkspace {
  drafts: Map<string, DraftLayer>;
  layers: Map<string, IfcxFile>;
  refs: Map<string, string[]>;
  reviews: Map<string, LayerReview>;
}

export function createLayerWorkspace(): LayerWorkspace {
  return {
    drafts: new Map(),
    layers: new Map(),
    refs: new Map([['main', []]]),
    reviews: new Map(),
  };
}

// Storage model (#1030). Drafts are private CRDT sessions, so they are
// the per-transport-session state: keyed by session id, disposed with the
// session. Published layers, refs, and reviews are the collaboration
// surface — content-addressed immutable layers, shared branch heads, and
// reviews that *other* principals must be able to act on from their own
// HTTP sessions (each principal necessarily holds a different session,
// since the transport rejects scope mismatches) — so they live in one
// process-wide store, gated by the visibility checks below. stdio /
// in-process transports carry no session id and use the local draft
// space — registry-less local mode (10-registry.md); durable,
// registry-backed persistence stays future work.
const shared = {
  layers: new Map<string, IfcxFile>(),
  refs: new Map<string, string[]>([['main', []]]),
  reviews: new Map<string, LayerReview>(),
};

const draftSpaces = new Map<string, Map<string, DraftLayer>>();

/** Draft-space key for transports without a session id (stdio, in-process, tests). */
const LOCAL_WORKSPACE_KEY = 'local';

export function getLayerWorkspace(sessionId?: string): LayerWorkspace {
  const key = sessionId ?? LOCAL_WORKSPACE_KEY;
  let drafts = draftSpaces.get(key);
  if (!drafts) {
    drafts = new Map();
    draftSpaces.set(key, drafts);
  }
  return { drafts, layers: shared.layers, refs: shared.refs, reviews: shared.reviews };
}

/** Drafts hold live Y.Docs — destroy them or the CRDT state lingers. */
function destroyDrafts(drafts: Map<string, DraftLayer>): void {
  for (const draft of drafts.values()) draft.doc.destroy();
}

/**
 * Drop a session's draft space when the transport session ends. Layers,
 * refs, and reviews deliberately survive — they are the published shared
 * record other sessions keep building on.
 */
export function disposeLayerWorkspace(sessionId: string): void {
  const drafts = draftSpaces.get(sessionId);
  if (!drafts) return;
  destroyDrafts(drafts);
  draftSpaces.delete(sessionId);
}

/** Test hook: drop all draft spaces and shared state; return a fresh local workspace. */
export function resetLayerWorkspace(): LayerWorkspace {
  for (const drafts of draftSpaces.values()) destroyDrafts(drafts);
  draftSpaces.clear();
  shared.layers.clear();
  shared.reviews.clear();
  shared.refs.clear();
  shared.refs.set('main', []);
  return getLayerWorkspace();
}

/** Files for a ref, erroring on dangling layer ids (corrupt workspace). */
export function refLayerFiles(ws: LayerWorkspace, name: string): IfcxFile[] {
  const ids = ws.refs.get(name);
  if (!ids) {
    throw new ToolExecutionError({
      code: ToolErrorCode.ENTITY_NOT_FOUND,
      message: `Unknown ref '${name}'.`,
      details: { refs: Array.from(ws.refs.keys()) },
    });
  }
  return ids.map((id) => {
    const file = ws.layers.get(id);
    if (!file) {
      throw new ToolExecutionError({
        code: ToolErrorCode.INTERNAL_ERROR,
        message: `Ref '${name}' points at unknown layer ${id}.`,
      });
    }
    return file;
  });
}

export interface ResolvedBase {
  base: ProvenanceBase | null;
  files: IfcxFile[];
}

/** Resolve a base spec (ref name or layer id; absent → no base). */
export function resolveBase(ws: LayerWorkspace, ref?: string): ResolvedBase {
  if (ref === undefined) return { base: null, files: [] };
  if (ws.refs.has(ref)) {
    const ids = ws.refs.get(ref) ?? [];
    const files = refLayerFiles(ws, ref);
    return {
      base: ids.length > 0 ? { kind: 'stack', id: computeStackHash(ids) } : null,
      files,
    };
  }
  const layer = ws.layers.get(ref);
  if (layer) {
    // Seed from the full ancestor stack when the layer sits inside a ref
    // history — a lone delta would lose all earlier state and put drafts
    // on the wrong baseline for previews and merge planning.
    const base: ProvenanceBase = { kind: 'layer', id: ref };
    const files = resolveAncestorFilesAnyRef(ws, base);
    return { base, files: files.length > 0 ? files : [layer] };
  }
  throw new ToolExecutionError({
    code: ToolErrorCode.ENTITY_NOT_FOUND,
    message: `Unknown base '${ref}' — not a ref name or published layer id.`,
    details: { refs: Array.from(ws.refs.keys()) },
  });
}

/**
 * Resolve a manifest base against a ref's layer ids: a stack base matches
 * a prefix stack hash, a layer base matches a prefix end (or a stored
 * stray layer). Best effort — unknown bases resolve to [].
 */
export function resolveAncestorFiles(
  ws: LayerWorkspace,
  base: ProvenanceBase | null,
  refIds: readonly string[],
): IfcxFile[] {
  if (!base) return [];
  if (base.kind === 'stack') {
    for (let i = 0; i <= refIds.length; i += 1) {
      if (computeStackHash(refIds.slice(0, i)) === base.id) {
        return refIds.slice(0, i).map((id) => ws.layers.get(id)).filter((f): f is IfcxFile => f !== undefined);
      }
    }
    return [];
  }
  const idx = refIds.indexOf(base.id);
  if (idx !== -1) {
    return refIds.slice(0, idx + 1).map((id) => ws.layers.get(id)).filter((f): f is IfcxFile => f !== undefined);
  }
  const single = ws.layers.get(base.id);
  return single ? [single] : [];
}

/**
 * Resolve a manifest base by searching every ref's layer list — used when
 * a tool gets a published layer without an explicit `into` ref, where an
 * empty ref list could never reconstruct a stack-hash base.
 */
export function resolveAncestorFilesAnyRef(
  ws: LayerWorkspace,
  base: ProvenanceBase | null,
): IfcxFile[] {
  if (!base) return [];
  for (const refIds of ws.refs.values()) {
    const files = resolveAncestorFiles(ws, base, refIds);
    if (files.length > 0) return files;
  }
  // Fall back to the lone-layer case resolveAncestorFiles also covers.
  return resolveAncestorFiles(ws, base, []);
}

/** Read the IfcClass code off the well-known class attribute, if present. */
export function ifcClassOfAttributes(attributes: Record<string, unknown> | undefined): string | undefined {
  const cls = attributes?.[ATTR.CLASS];
  if (cls && typeof cls === 'object' && 'code' in cls) {
    const code = (cls as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/**
 * Fold an ordered layer stack (weakest first) into a draft Y.Doc.
 *
 * Unlike `seedFromIfcx` (whose `createEntity` is a no-op on existing
 * paths), this applies later layers' opinions on top: nulls remove,
 * tombstones delete, values overwrite.
 */
export function seedDraftDoc(doc: Y.Doc, files: readonly IfcxFile[]): void {
  doc.transact(() => {
    for (const file of files) {
      for (const node of file.data) {
        applyNode(doc, file, node);
      }
    }
  });
}

function applyNode(doc: Y.Doc, file: IfcxFile, node: IfcxNodeLike): void {
  if (node.attributes?.[IFCLITE_ATTR.DELETED] === true) {
    deleteEntity(doc, node.path);
    return;
  }
  if (!hasEntity(doc, node.path)) {
    const ifcClass = ifcClassOfAttributes(node.attributes);
    const inherits: Record<string, string> = {};
    for (const [role, target] of Object.entries(node.inherits ?? {})) {
      if (typeof target === 'string') inherits[role] = target;
    }
    createEntity(doc, node.path, {
      ifcClass,
      inherits,
      meta: {
        ifcClass,
        createdAt: file.header.timestamp,
        createdBy: file.header.author,
      },
    });
  }
  for (const [key, value] of Object.entries(node.attributes ?? {})) {
    if (key === IFCLITE_ATTR.DELETED) continue;
    if (value === null) deleteAttribute(doc, node.path, key);
    else setAttribute(doc, node.path, key, value);
  }
  for (const [role, child] of Object.entries(node.children ?? {})) {
    if (child === null) removeChild(doc, node.path, role);
    else setChild(doc, node.path, role, child);
  }
  // Inherits deltas must replay on existing entities too — `createEntity`
  // only applies them on first creation, but later base layers may add,
  // retarget, or null out inheritance opinions.
  for (const [role, target] of Object.entries(node.inherits ?? {})) {
    if (target === null) removeInherit(doc, node.path, role);
    else if (typeof target === 'string') setInherit(doc, node.path, role, target);
  }
}

interface IfcxNodeLike {
  path: string;
  attributes?: Record<string, unknown>;
  children?: Record<string, string | null>;
  inherits?: Record<string, string | null>;
}

export interface CreateDraftInit {
  base: ProvenanceBase | null;
  baseFiles: IfcxFile[];
  intent: string;
  claims: ScopeClaim[];
  rawClaims: string[];
  session?: string;
  owner?: string;
}

/** Build, seed, baseline, and register a new draft. */
export function createDraft(ws: LayerWorkspace, init: CreateDraftInit): DraftLayer {
  const doc = createCollabDoc({ gc: false });
  seedDraftDoc(doc, init.baseFiles);
  const draft: DraftLayer = {
    id: randomUUID(),
    doc,
    baseline: Y.encodeStateAsUpdate(doc),
    base: init.base,
    baseFiles: init.baseFiles,
    intent: init.intent,
    claims: init.claims,
    rawClaims: init.rawClaims,
    session: init.session ?? randomUUID(),
    owner: init.owner,
    createdAt: new Date().toISOString(),
  };
  ws.drafts.set(draft.id, draft);
  return draft;
}
