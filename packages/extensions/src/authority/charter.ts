/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Charters: the machine-readable responsibility matrix.
 *
 * A charter maps roles to principals and attribute selectors to roles:
 *
 *   { "v": 1, "basis": "...",
 *     "roles": { "fire-consultant": ["fire@consult.example"] },
 *     "rules": [{ "id": "fire-rating-walls",
 *                 "selector": "model.mutate:Pset_WallCommon.FireRating@IfcWall*",
 *                 "role": "fire-consultant" }] }
 *
 * Selectors are scope claims (07 §7.1) with a `model.mutate` capability;
 * the target names attribute keys (see `attribute-path.ts`).
 *
 * The governing rule for an attribute is the MOST SPECIFIC match: more
 * target segments first (member before set before component), then more
 * literal segments, then exact type before glob before no type, then more
 * constraints. Two equally specific rules that can match one attribute
 * and name different roles make the charter invalid, so authority is
 * never ambiguous at evaluation time.
 *
 * Spec: docs/architecture/layer-prs/12-authority.md §12.3.
 */

import type { ValidationError, ValidationResult } from '../types.js';
import { parseScopeClaim, type ScopeClaim } from '../capability/scope-claim.js';
import { targetMatchesAttribute, targetsOverlap, typePatternsOverlap } from './attribute-path.js';

/** Header key carrying the charter on a charter-ref layer. */
export const AUTHORITY_HEADER_KEY = 'ifclite::authority';

export interface CharterRule {
  id: string;
  /** Original selector string. */
  selector: string;
  role: string;
  claim: ScopeClaim;
  /** Lexicographic specificity, higher wins. */
  specificity: readonly number[];
}

export interface Charter {
  v: 1;
  basis?: string;
  /** Role → principals holding it. */
  roles: ReadonlyMap<string, ReadonlySet<string>>;
  rules: readonly CharterRule[];
}

/** What resolution knows about the entity an attribute belongs to. */
export interface AttributeSubject {
  attributeKey: string;
  /** IFC class of the entity, when known. Typed rules never match without it. */
  ifcType?: string;
  /** Entity tags (e.g. `storey`). Unknown tags fail closed, as in scope claims. */
  tags?: Readonly<Record<string, string>>;
}

const ROLE_RE = /^[a-z][a-z0-9-]*$/;

function error(path: string, code: ValidationError['code'], message: string, hint?: string): ValidationError {
  const err: ValidationError = { path, code, message };
  if (hint) err.hint = hint;
  return err;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function specificityOf(claim: ScopeClaim): number[] {
  const target = claim.capability.target;
  const segments = !target || target.isUniversalWildcard ? [] : target.segments;
  const literals = segments.filter((s) => s.kind === 'literal' && !s.value.endsWith('*')).length;
  const type = claim.selector?.ifcType;
  const typeRank = type === undefined ? 0 : type.endsWith('*') ? 1 : 2;
  const constraints = Object.keys(claim.selector?.constraints ?? {}).length;
  return [segments.length, literals, typeRank, constraints];
}

function compareSpecificity(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/** Could both rules govern one attribute of one entity? */
function rulesOverlap(a: ScopeClaim, b: ScopeClaim): boolean {
  if (!a.capability.target || !b.capability.target) return false;
  if (!targetsOverlap(a.capability.target, b.capability.target)) return false;
  const aType = a.selector?.ifcType;
  const bType = b.selector?.ifcType;
  if (aType !== undefined && bType !== undefined && !typePatternsOverlap(aType, bType)) return false;
  const bConstraints = b.selector?.constraints ?? {};
  for (const [key, value] of Object.entries(a.selector?.constraints ?? {})) {
    if (Object.prototype.hasOwnProperty.call(bConstraints, key) && bConstraints[key] !== value) return false;
  }
  return true;
}

function parseRoles(raw: unknown, errors: ValidationError[]): Map<string, Set<string>> {
  const roles = new Map<string, Set<string>>();
  if (!isRecord(raw)) {
    errors.push(error('roles', 'type_mismatch', 'Charter "roles" must map role names to principal lists.'));
    return roles;
  }
  for (const [role, principals] of Object.entries(raw)) {
    if (!ROLE_RE.test(role)) {
      errors.push(error(`roles.${role}`, 'invalid_id', `Role "${role}" must be lower-case kebab-case.`));
      continue;
    }
    if (!Array.isArray(principals) || !principals.every((p) => typeof p === 'string' && p.length > 0)) {
      errors.push(error(`roles.${role}`, 'type_mismatch', `Role "${role}" must list principals as non-empty strings.`));
      continue;
    }
    roles.set(role, new Set(principals as string[]));
  }
  return roles;
}

function parseRule(raw: unknown, path: string, roles: ReadonlyMap<string, unknown>, errors: ValidationError[]): CharterRule | undefined {
  if (!isRecord(raw)) {
    errors.push(error(path, 'type_mismatch', 'Charter rule must be an object.'));
    return undefined;
  }
  const { id, selector, role } = raw;
  if (typeof id !== 'string' || id.length === 0) {
    errors.push(error(`${path}.id`, 'required', 'Charter rule needs a non-empty "id".'));
    return undefined;
  }
  if (typeof role !== 'string' || !roles.has(role)) {
    errors.push(error(`${path}.role`, 'invalid_reference', `Rule "${id}" names role "${String(role)}", which "roles" does not define.`));
    return undefined;
  }
  if (typeof selector !== 'string') {
    errors.push(error(`${path}.selector`, 'required', `Rule "${id}" needs a "selector" string.`));
    return undefined;
  }
  const parsed = parseScopeClaim(selector);
  if (!parsed.ok) {
    errors.push(...parsed.errors.map((e) => ({ ...e, path: `${path}.selector` })));
    return undefined;
  }
  const capability = parsed.value.capability;
  if (capability.scope !== 'model' || capability.action !== 'mutate' || !capability.target) {
    errors.push(error(
      `${path}.selector`,
      'invalid_capability',
      `Rule "${id}" selector must be "model.mutate:<target>", got "${selector}".`,
      'Example: "model.mutate:Pset_WallCommon.FireRating@IfcWall*".'
    ));
    return undefined;
  }
  return { id, selector, role, claim: parsed.value, specificity: specificityOf(parsed.value) };
}

/**
 * Parse and validate the `ifclite::authority` block of a charter layer.
 * All errors are reported at once; an ambiguous pair is reported by both
 * rule ids.
 */
export function parseCharter(raw: unknown): ValidationResult<Charter> {
  if (!isRecord(raw)) {
    return { ok: false, errors: [error('', 'type_mismatch', 'Charter must be an object.')] };
  }
  const errors: ValidationError[] = [];
  if (raw.v !== 1) {
    errors.push(error('v', 'invalid_manifest_version', `Unsupported charter version ${JSON.stringify(raw.v)}; expected 1.`));
  }
  if (raw.basis !== undefined && typeof raw.basis !== 'string') {
    errors.push(error('basis', 'type_mismatch', 'Charter "basis" must be a string.'));
  }
  const roles = parseRoles(raw.roles, errors);
  const rules: CharterRule[] = [];
  if (!Array.isArray(raw.rules)) {
    errors.push(error('rules', 'type_mismatch', 'Charter "rules" must be an array.'));
  } else {
    const ids = new Set<string>();
    raw.rules.forEach((entry, i) => {
      const rule = parseRule(entry, `rules[${i}]`, roles, errors);
      if (!rule) return;
      if (ids.has(rule.id)) {
        errors.push(error(`rules[${i}].id`, 'invalid_id', `Duplicate rule id "${rule.id}".`));
        return;
      }
      ids.add(rule.id);
      rules.push(rule);
    });
  }

  for (let i = 0; i < rules.length; i += 1) {
    for (let j = i + 1; j < rules.length; j += 1) {
      const a = rules[i];
      const b = rules[j];
      if (a.role === b.role || compareSpecificity(a.specificity, b.specificity) !== 0) continue;
      if (!rulesOverlap(a.claim, b.claim)) continue;
      errors.push(error(
        'rules',
        'ambiguous_authority',
        `Rules "${a.id}" (${a.role}) and "${b.id}" (${b.role}) are equally specific and can govern the same attribute.`,
        'Narrow one selector (member, exact type or a constraint) or give both the same role.'
      ));
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  const charter: Charter = { v: 1, roles, rules };
  if (typeof raw.basis === 'string') charter.basis = raw.basis;
  return { ok: true, value: charter };
}

function ruleMatches(rule: CharterRule, subject: AttributeSubject): boolean {
  const { claim } = rule;
  if (!claim.capability.target || !targetMatchesAttribute(claim.capability.target, subject.attributeKey)) return false;
  if (!claim.selector) return true;
  const { ifcType, constraints } = claim.selector;
  if (subject.ifcType === undefined) return false;
  if (ifcType.endsWith('*') ? !subject.ifcType.startsWith(ifcType.slice(0, -1)) : ifcType !== subject.ifcType) return false;
  const tags = subject.tags ?? {};
  return Object.entries(constraints).every(([key, value]) => Object.prototype.hasOwnProperty.call(tags, key) && tags[key] === value);
}

/** The most specific rule governing an attribute, or undefined when none does. */
export function findGoverningRule(charter: Charter, subject: AttributeSubject): CharterRule | undefined {
  let best: CharterRule | undefined;
  for (const rule of charter.rules) {
    if (!ruleMatches(rule, subject)) continue;
    if (!best || compareSpecificity(rule.specificity, best.specificity) > 0) best = rule;
  }
  return best;
}
