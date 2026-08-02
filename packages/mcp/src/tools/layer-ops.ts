/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Capability derivation for draft ops — the shared vocabulary between
 * write-time enforcement (each op matched against the draft's scope
 * claims *before* it touches the Y.Doc) and publish-time verification
 * (descriptors re-derived from the frozen layer's data nodes and checked
 * against the manifest's `scope_claim`; mismatches are reported, never
 * silently accepted).
 *
 * Spec: docs/architecture/layer-prs/06-agents.md §6.4, 07-security.md §7.1.
 */

import { findCoveringClaim, parseScopeClaims } from '@ifc-lite/extensions';
import type { ScopeClaim, ScopeOpDescriptor } from '@ifc-lite/extensions';
import { extractStackState } from '@ifc-lite/merge';
import { IFCLITE_ATTR } from '@ifc-lite/ifcx';
import type { IfcxFile } from '@ifc-lite/ifcx';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';
import { ifcClassOfAttributes } from './layer-store.js';

export type DraftOpKind = 'create_entity' | 'set_attribute' | 'set_property' | 'delete_entity';

export interface DraftOpInput {
  op: DraftOpKind;
  path: string;
  ifc_type?: string;
  name?: string;
  pset?: string;
  prop?: string;
  value?: unknown;
}

/** `Pset_*` / `Qto_*` segment anywhere in a namespaced attribute key. */
const PSET_QTO_RE = /(?:^|::)((?:Pset|Qto)_[A-Za-z0-9_]+)(?:::|$)/;

/**
 * Capability target for an attribute key: the Pset/Qto set name when the
 * key carries one, else the last `::` segment (write-time and publish-time
 * use the same normalization so they cannot drift).
 */
export function mutationTarget(attributeKey: string): string {
  const match = PSET_QTO_RE.exec(attributeKey);
  if (match) return match[1];
  const segments = attributeKey.split('::');
  return segments[segments.length - 1];
}

/** Write-time descriptor for one draft op. */
export function descriptorForDraftOp(op: DraftOpInput, ifcType: string | undefined): ScopeOpDescriptor {
  switch (op.op) {
    case 'create_entity':
      return { capability: 'model.create', ...(ifcType !== undefined ? { ifcType } : {}) };
    case 'delete_entity':
      return { capability: 'model.delete', ...(ifcType !== undefined ? { ifcType } : {}) };
    case 'set_property':
      return { capability: `model.mutate:${op.pset}`, ...(ifcType !== undefined ? { ifcType } : {}) };
    case 'set_attribute':
      return {
        capability: `model.mutate:${mutationTarget(op.name ?? '')}`,
        ...(ifcType !== undefined ? { ifcType } : {}),
      };
  }
}

/**
 * Write-time enforcement: drafts with claims only accept covered ops;
 * drafts with empty claims are unrestricted. Throws the structured error
 * the agent can reason about.
 */
export function assertOpWithinClaims(
  claims: readonly ScopeClaim[],
  rawClaims: readonly string[],
  descriptor: ScopeOpDescriptor,
  op: DraftOpInput,
): void {
  if (claims.length === 0) return;
  if (findCoveringClaim(claims, descriptor)) return;
  throw new ToolExecutionError({
    code: ToolErrorCode.PERMISSION_DENIED,
    message: `scope does not permit ${descriptor.capability}; request elevation or narrow the task`,
    details: {
      op: { ...op },
      capability: descriptor.capability,
      ifcType: descriptor.ifcType,
      claims: [...rawClaims],
    },
    hint: 'Create a new draft with a wider scope, or drop the offending op.',
  });
}

export interface ScopeMismatch {
  path: string;
  capability: string;
  ifcType?: string;
}

export interface ScopeVerification {
  verified: boolean;
  mismatches: ScopeMismatch[];
}

/**
 * Publish-time descriptors from a frozen layer's data nodes (same mapping
 * as the CLI's `deriveScopeOps`):
 *   - tombstone opinion (`ifclite::deleted`) → model.delete
 *   - path absent from the base stack state  → model.create
 *   - attribute keys on existing entities    → model.mutate:<target>
 * `ifclite::*` bookkeeping keys never produce ops.
 */
export function deriveLayerDescriptors(
  file: IfcxFile,
  baseFiles: readonly IfcxFile[],
): Array<ScopeOpDescriptor & { path: string }> {
  const baseState = extractStackState(baseFiles);
  const out: Array<ScopeOpDescriptor & { path: string }> = [];

  for (const node of file.data) {
    const baseEntity = baseState.get(node.path);
    const baseClassAttrs = baseEntity?.components.get('attr:class');
    const ifcType =
      ifcClassOfAttributes(baseClassAttrs) ?? ifcClassOfAttributes(node.attributes);
    const typed = ifcType !== undefined ? { ifcType } : {};

    if (node.attributes?.[IFCLITE_ATTR.DELETED] === true) {
      out.push({ capability: 'model.delete', path: node.path, ...typed });
      continue;
    }
    if (baseEntity === undefined || baseEntity.deleted) {
      out.push({ capability: 'model.create', path: node.path, ...typed });
      continue;
    }
    for (const key of Object.keys(node.attributes ?? {})) {
      if (key === IFCLITE_ATTR.DELETED || key.startsWith(IFCLITE_ATTR.DERIVED)) continue;
      out.push({ capability: `model.mutate:${mutationTarget(key)}`, path: node.path, ...typed });
    }
  }
  return out;
}

/**
 * Verify a published layer's actual ops against its manifest scope claims.
 * Empty claims mean an unrestricted draft — trivially verified.
 */
export function verifyLayerAgainstClaims(
  file: IfcxFile,
  baseFiles: readonly IfcxFile[],
  rawClaims: readonly string[],
): ScopeVerification {
  if (rawClaims.length === 0) return { verified: true, mismatches: [] };

  const parsed = parseScopeClaims(rawClaims);
  if (!parsed.ok) {
    throw new ToolExecutionError({
      code: ToolErrorCode.INVALID_INPUT,
      message: 'Manifest scope claims failed to parse during publish verification.',
      details: { errors: parsed.errors },
    });
  }

  const mismatches: ScopeMismatch[] = [];
  for (const descriptor of deriveLayerDescriptors(file, baseFiles)) {
    if (findCoveringClaim(parsed.value, descriptor)) continue;
    mismatches.push({
      path: descriptor.path,
      capability: descriptor.capability,
      ...(descriptor.ifcType !== undefined ? { ifcType: descriptor.ifcType } : {}),
    });
  }
  return { verified: mismatches.length === 0, mismatches };
}
