/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Provenance manifest (extension namespace `ifclite::provenance`,
 * manifest SemVer v1).
 *
 * Every published layer carries one: who (human/agent/hybrid principal),
 * why (intent), against what (base layer or stack), what it claims to
 * touch (scope claims), which checks ran, and — for merge layers — how
 * conflicts were resolved.
 *
 * Spec: docs/architecture/layer-prs/03-provenance.md.
 */

import type { IfcxFile, IfcxHeader } from './types.js';
import { PROVENANCE_KEY } from './types.js';

export const PROVENANCE_VERSION = 1;

export type AuthorKind = 'agent' | 'human' | 'hybrid';

export interface ProvenanceAuthor {
  kind: AuthorKind;
  /** Authenticated principal (human as principal even for hybrid drafts). */
  principal: string;
  /** Authoring tool, e.g. `@ifc-lite/mcp@0.4.0`. */
  tool?: string;
  /** Model identifier for agent/hybrid authors. */
  model?: string;
  /** Draft session id; groups a stack of layers from one task. */
  session?: string;
}

export interface ProvenanceBase {
  kind: 'layer' | 'stack';
  /** `blake3:` layer id or stack hash. */
  id: string;
}

export interface IdentityMapEntry {
  /** Entity identity in the base. */
  base: string;
  /** Entity identity in this layer. */
  here: string;
  /** Human-readable reason; `"derived"` for content-derived fallbacks. */
  reason: string;
}

export interface ProvenanceCheck {
  /** Check tool, e.g. `@ifc-lite/ids@2.x`. */
  tool: string;
  /** Spec file/name the check ran against. */
  spec?: string;
  /** blake3 digest of the spec content. */
  specDigest?: string;
  result: 'pass' | 'fail';
  /** blake3 digest of the content-addressed report. */
  report?: string;
}

export interface MergeResolution {
  entity: string;
  componentKey?: string;
  choice: 'ours' | 'theirs' | 'edited';
}

export interface WaivedCheck {
  spec: string;
  reason: string;
  /** Principal who waived the check. */
  waivedBy: string;
}

export interface MergeRecord {
  /** Candidate layer id that was merged. */
  candidate: string;
  /** Target ref name or stack hash the candidate merged into. */
  into: string;
  resolutions: MergeResolution[];
  waived_checks: WaivedCheck[];
  /** Principal who resolved the merge. */
  resolver: string;
}

export interface ProvenanceSignature {
  alg: 'ed25519';
  key: string;
  sig: string;
}

export interface ProvenanceManifest {
  v: typeof PROVENANCE_VERSION;
  author: ProvenanceAuthor;
  /** Human-readable why. Mandatory: the `ifc layer log` line. */
  intent: string;
  /** blake3 of the full prompt/task text that produced the layer. */
  instructions_digest?: string;
  /** ISO 8601 creation timestamp. */
  created: string;
  /** Base the layer was authored against (null for base/import layers). */
  base: ProvenanceBase | null;
  /** Parent layer ids in the change DAG. */
  parents: string[];
  /** Capability-grammar scope claims (07-security.md §7.1). */
  scope_claim: string[];
  identity_map: IdentityMapEntry[];
  checks: ProvenanceCheck[];
  /** Filled on merge layers only. */
  merge: MergeRecord | null;
  /** ed25519 signatures over the layer id; excluded from the id itself. */
  signatures: ProvenanceSignature[];
}

/** Input for building a v1 manifest with defaults for optional lists. */
export interface ProvenanceInit {
  author: ProvenanceAuthor;
  intent: string;
  base: ProvenanceBase | null;
  created?: string;
  instructions_digest?: string;
  parents?: string[];
  scope_claim?: string[];
  identity_map?: IdentityMapEntry[];
  checks?: ProvenanceCheck[];
  merge?: MergeRecord | null;
  signatures?: ProvenanceSignature[];
}

export function createProvenanceManifest(init: ProvenanceInit): ProvenanceManifest {
  const manifest: ProvenanceManifest = {
    v: PROVENANCE_VERSION,
    author: init.author,
    intent: init.intent,
    created: init.created ?? new Date().toISOString(),
    base: init.base,
    parents: init.parents ?? [],
    scope_claim: init.scope_claim ?? [],
    identity_map: init.identity_map ?? [],
    checks: init.checks ?? [],
    merge: init.merge ?? null,
    signatures: init.signatures ?? [],
  };
  if (init.instructions_digest !== undefined) {
    manifest.instructions_digest = init.instructions_digest;
  }
  const errors = validateProvenance(manifest);
  if (errors.length > 0) {
    throw new Error(`Invalid provenance manifest: ${errors.join('; ')}`);
  }
  return manifest;
}

type HeaderWithProvenance = IfcxHeader & {
  [PROVENANCE_KEY]?: ProvenanceManifest;
};

/** Read the provenance manifest off a layer document, if present. */
export function getProvenance(file: IfcxFile): ProvenanceManifest | undefined {
  return (file.header as HeaderWithProvenance)[PROVENANCE_KEY];
}

/** Return a copy of the layer document with the manifest set on the header. */
export function setProvenance(file: IfcxFile, manifest: ProvenanceManifest): IfcxFile {
  const errors = validateProvenance(manifest);
  if (errors.length > 0) {
    throw new Error(`Invalid provenance manifest: ${errors.join('; ')}`);
  }
  const header: HeaderWithProvenance = { ...file.header, [PROVENANCE_KEY]: manifest };
  return { ...file, header };
}

const AUTHOR_KINDS: readonly string[] = ['agent', 'human', 'hybrid'];

/**
 * Structural validation of an untrusted manifest value.
 * Returns a list of problems; empty means valid.
 */
export function validateProvenance(value: unknown): string[] {
  const errors: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return ['manifest must be an object'];
  }
  const m = value as Record<string, unknown>;

  if (m.v !== PROVENANCE_VERSION) errors.push(`v must be ${PROVENANCE_VERSION}`);

  const author = m.author;
  if (typeof author !== 'object' || author === null) {
    errors.push('author is required');
  } else {
    const a = author as Record<string, unknown>;
    if (typeof a.kind !== 'string' || !AUTHOR_KINDS.includes(a.kind)) {
      errors.push('author.kind must be agent | human | hybrid');
    }
    if (typeof a.principal !== 'string' || a.principal.length === 0) {
      errors.push('author.principal is required');
    }
  }

  if (typeof m.intent !== 'string' || m.intent.trim().length === 0) {
    errors.push('intent is mandatory and must be non-empty');
  }
  if (typeof m.created !== 'string' || Number.isNaN(Date.parse(m.created))) {
    errors.push('created must be an ISO 8601 timestamp');
  }

  if (m.base !== null) {
    const base = m.base as Record<string, unknown> | undefined;
    if (typeof base !== 'object' || base === null) {
      errors.push('base must be null or { kind, id }');
    } else {
      if (base.kind !== 'layer' && base.kind !== 'stack') {
        errors.push('base.kind must be layer | stack');
      }
      if (typeof base.id !== 'string' || !base.id.startsWith('blake3:')) {
        errors.push('base.id must be a blake3: content address');
      }
    }
  }

  for (const [field, check] of [
    ['parents', (entry: unknown) => typeof entry === 'string'],
    ['scope_claim', (entry: unknown) => typeof entry === 'string'],
  ] as const) {
    const list = m[field];
    if (!Array.isArray(list) || !list.every(check)) {
      errors.push(`${field} must be an array of strings`);
    }
  }

  if (!Array.isArray(m.identity_map)) {
    errors.push('identity_map must be an array');
  } else {
    for (const entry of m.identity_map) {
      const e = entry as Record<string, unknown>;
      if (
        typeof e !== 'object' ||
        e === null ||
        typeof e.base !== 'string' ||
        typeof e.here !== 'string' ||
        typeof e.reason !== 'string'
      ) {
        errors.push('identity_map entries must be { base, here, reason }');
        break;
      }
    }
  }

  if (!Array.isArray(m.checks)) {
    errors.push('checks must be an array');
  } else {
    for (const entry of m.checks) {
      const c = entry as Record<string, unknown>;
      if (
        typeof c !== 'object' ||
        c === null ||
        typeof c.tool !== 'string' ||
        (c.result !== 'pass' && c.result !== 'fail')
      ) {
        errors.push('checks entries must carry tool and result pass | fail');
        break;
      }
    }
  }

  if (m.merge !== null && m.merge !== undefined) {
    const merge = m.merge as Record<string, unknown>;
    if (
      typeof merge !== 'object' ||
      merge === null ||
      typeof merge.candidate !== 'string' ||
      typeof merge.into !== 'string' ||
      typeof merge.resolver !== 'string' ||
      !Array.isArray(merge.resolutions) ||
      !Array.isArray(merge.waived_checks)
    ) {
      errors.push('merge must be null or { candidate, into, resolutions, waived_checks, resolver }');
    }
  }

  if (!Array.isArray(m.signatures)) {
    errors.push('signatures must be an array');
  }

  return errors;
}
