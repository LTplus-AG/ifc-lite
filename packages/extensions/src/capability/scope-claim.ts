/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Layer scope claims: the capability grammar extended with entity
 * selectors. Layers are just another principal asking for authority, so
 * manifests and grants reuse `parseCapability`/`matchCapability` for the
 * capability half and add a selector half:
 *
 *   scope-claim := capability [ "@" selector ]
 *   selector    := ifcType ( "&" constraint )*
 *   constraint  := key "=" value
 *
 * Examples:
 *   model.mutate:Pset_FireSafety*@IfcWall&storey=EG
 *   model.create:IfcPropertySet
 *   model.delete:@IfcAnnotation
 *
 * Whitespace around `@`, `&` and `=` is tolerated (the spec renders
 * claims spaced for readability). The ifcType supports a trailing `*`
 * glob (`IfcWall*` covers `IfcWallStandardCase`).
 *
 * Spec: docs/architecture/layer-prs/07-security.md §7.1.
 */

import type { Capability, ValidationError, ValidationResult } from '../types.js';
import { parseCapability } from './parse.js';
import { matchCapability } from './match.js';

export interface EntitySelector {
  /** IFC type pattern; trailing `*` is a prefix glob. */
  ifcType: string;
  /** Equality constraints over entity tags (e.g. `storey=EG`). */
  constraints: Record<string, string>;
}

export interface ScopeClaim {
  /** Original claim string (for manifests and round-tripping). */
  raw: string;
  capability: Capability;
  /** Entity selector, if an `@selector` was provided. */
  selector?: EntitySelector;
}

/** A concrete op (or op summary) checked against a claim or grant. */
export interface ScopeOpDescriptor {
  /** Capability the op exercises, e.g. `model.mutate:Pset_FireSafety`. */
  capability: string;
  /** IFC type of the touched entity, when known. */
  ifcType?: string;
  /** Entity tags the enforcement point can resolve (e.g. `storey`). */
  tags?: Record<string, string>;
}

// Selector types must be IFC EXPRESS class names (PascalCase, `Ifc`
// prefix), optionally with a trailing `*` glob — never invented aliases.
const IFC_TYPE_GLOB_RE = /^Ifc[A-Z][A-Za-z0-9]*\*?$/;
const CONSTRAINT_KEY_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

function fail(message: string, hint?: string): ValidationResult<never> {
  const error: ValidationError = { path: '', code: 'invalid_capability', message };
  if (hint) error.hint = hint;
  return { ok: false, errors: [error] };
}

/** Parse one scope-claim expression. */
export function parseScopeClaim(raw: string): ValidationResult<ScopeClaim> {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return fail('Scope claim must be a non-empty string.');
  }

  const atIdx = raw.indexOf('@');
  const capabilityPart = (atIdx === -1 ? raw : raw.slice(0, atIdx)).trim();
  const selectorPart = atIdx === -1 ? undefined : raw.slice(atIdx + 1).trim();

  // The capability grammar itself is whitespace-strict; normalize the
  // spec's readable spacing ("model.mutate : Pset_*") before delegating.
  const capabilityResult = parseCapability(capabilityPart.replace(/\s*:\s*/, ':'));
  if (!capabilityResult.ok) return capabilityResult;

  const claim: ScopeClaim = { raw, capability: capabilityResult.value };
  if (selectorPart === undefined) return { ok: true, value: claim };

  if (selectorPart.length === 0) {
    return fail(`Scope claim "${raw}" has "@" but no selector.`, 'Supply an IFC type, e.g. "@IfcWall".');
  }

  const pieces = selectorPart.split('&').map((piece) => piece.trim());
  const ifcType = pieces[0];
  if (!IFC_TYPE_GLOB_RE.test(ifcType)) {
    return fail(
      `Selector type "${ifcType}" is not a valid IFC type pattern.`,
      'Use the exact IFC EXPRESS class name (e.g. "IfcWall"), optionally with a trailing "*".'
    );
  }

  const constraints: Record<string, string> = {};
  for (const piece of pieces.slice(1)) {
    const eqIdx = piece.indexOf('=');
    if (eqIdx === -1) {
      return fail(`Selector constraint "${piece}" must be key=value.`);
    }
    const key = piece.slice(0, eqIdx).trim();
    const value = piece.slice(eqIdx + 1).trim();
    if (!CONSTRAINT_KEY_RE.test(key) || value.length === 0) {
      return fail(`Selector constraint "${piece}" must be key=value.`);
    }
    constraints[key] = value;
  }

  claim.selector = { ifcType, constraints };
  return { ok: true, value: claim };
}

/** Parse a manifest's claim list; all-or-nothing like `parseCapabilities`. */
export function parseScopeClaims(raws: readonly string[]): ValidationResult<ScopeClaim[]> {
  const claims: ScopeClaim[] = [];
  const errors: ValidationError[] = [];
  for (const raw of raws) {
    const result = parseScopeClaim(raw);
    if (result.ok) claims.push(result.value);
    else errors.push(...result.errors);
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: claims };
}

function typePatternCovers(pattern: string, type: string): boolean {
  if (pattern.endsWith('*')) return type.startsWith(pattern.slice(0, -1));
  return pattern === type;
}

/**
 * Returns true iff `grant` covers `claim` — the claim asks for the same
 * or less authority. Used at draft creation (claim vs session grant) and
 * merge time (manifest claim vs ref policy).
 *
 * Selector logic: a grant without a selector covers any selector; a grant
 * with a selector requires the claim to be at least as narrow (claim type
 * within grant type pattern, claim carrying every grant constraint with
 * an equal value).
 */
export function scopeClaimCovers(grant: ScopeClaim, claim: ScopeClaim): boolean {
  if (!matchCapability(grant.capability, claim.capability)) return false;
  if (!grant.selector) return true;
  if (!claim.selector) return false;

  if (!typePatternCovers(grant.selector.ifcType, claim.selector.ifcType)) {
    // Allow pattern-vs-pattern narrowing: `IfcWall*` covers `IfcWall*`
    // and `IfcWallStandardCase`, never the reverse.
    const claimType = claim.selector.ifcType;
    if (!(claimType.endsWith('*') && grant.selector.ifcType.endsWith('*') &&
          claimType.slice(0, -1).startsWith(grant.selector.ifcType.slice(0, -1)))) {
      return false;
    }
  }

  for (const [key, value] of Object.entries(grant.selector.constraints)) {
    if (claim.selector.constraints[key] !== value) return false;
  }
  return true;
}

/**
 * Returns true iff a concrete op falls within a claim. This is the
 * write-time and publish-time enforcement primitive: each op is matched
 * before it touches the draft, and actual ops are verified against the
 * manifest's `scope_claim` at publish.
 *
 * Unknown tag values fail closed: if the claim constrains `storey=EG`
 * and the op cannot resolve a `storey` tag, the op does not match.
 */
export function opMatchesScopeClaim(claim: ScopeClaim, op: ScopeOpDescriptor): boolean {
  const opCapability = parseCapability(op.capability);
  if (!opCapability.ok) return false;
  if (!matchCapability(claim.capability, opCapability.value)) return false;

  if (!claim.selector) return true;
  if (op.ifcType === undefined || !typePatternCovers(claim.selector.ifcType, op.ifcType)) {
    return false;
  }
  for (const [key, value] of Object.entries(claim.selector.constraints)) {
    if ((op.tags ?? {})[key] !== value) return false;
  }
  return true;
}

/** First claim in the set covering the op, or undefined (structured-deny). */
export function findCoveringClaim(
  claims: readonly ScopeClaim[],
  op: ScopeOpDescriptor,
): ScopeClaim | undefined {
  for (const claim of claims) {
    if (opMatchesScopeClaim(claim, op)) return claim;
  }
  return undefined;
}
