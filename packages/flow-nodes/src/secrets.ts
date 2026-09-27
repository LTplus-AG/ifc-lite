/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Secrets from the host environment (#5167 phase 3.5).
 *
 * A node param references a secret with `{{secret:NAME}}` inside a
 * string value (or a string nested inside a `json`-kind param, e.g. a
 * header map). The grammar itself is recognised by `@ifc-lite/flow`'s
 * `referencedSecrets` (availability needs it too); this module is the one
 * place declared-vs-referenced is cross-checked and `process.env` is read —
 * shared by `packages/cli/src/commands/flow.ts` (`flow run`) and
 * `packages/mcp/src/tools/flow.ts` (`run_flow`), the only two callers
 * allowed to read `process.env` for a flow graph. The viewer never calls
 * this module: `HostFeatures.secrets` is always the empty set there, so
 * a graph referencing a secret shows `unavailable` before it runs (see
 * `availability.ts`), not this module's validation error.
 *
 * Two checks run BEFORE any node executes:
 *   1. every `{{secret:NAME}}` reference must be covered by a declared
 *      `secret.read:NAME` capability in the graph — an undeclared
 *      reference is a validation error, not a silently-empty string;
 *   2. every declared-and-referenced secret must actually be set in the
 *      environment — a referenced-but-unset secret is also a validation
 *      error, not an empty string interpolated into a request.
 *
 * Redaction (`buildRedactionMap` / `redactDeep`) is a separate, later
 * step the caller applies at the OUTER boundary — right before writing
 * to stdout, an MCP response, or a log sink — so a secret value that
 * reaches a remote response body (a server echoing back an Authorization
 * header) and comes back into the run's own output is still caught, not
 * just the point where `{{secret:NAME}}` was first substituted. See the
 * module doc trade-offs below on the minimum-length cutoff.
 */

import { referencedSecrets, replaceSecretRefs, type FlowDocument, type FlowNode } from '@ifc-lite/flow';

export { referencedSecrets };
import { parseCapabilities } from '@ifc-lite/extensions';

export interface SecretValidationError {
  readonly nodeId: string;
  readonly param: string;
  readonly name: string;
  readonly reason: 'undeclared' | 'unset';
  readonly message: string;
}

/** Every `secret:NAME` the graph's capabilities declare (from `secret.read:<NAME>` grants). */
export function declaredSecrets(doc: FlowDocument): ReadonlySet<string> {
  const parsed = parseCapabilities(doc.capabilities);
  const names = new Set<string>();
  if (!parsed.ok) return names;
  for (const cap of parsed.value) {
    if (cap.scope === 'secret' && cap.action === 'read' && cap.target?.segments.length === 1) {
      const seg = cap.target.segments[0];
      if (seg.kind === 'literal') names.add(seg.value);
    }
  }
  return names;
}

/**
 * Validate every `{{secret:NAME}}` reference against the graph's declared
 * capabilities AND the environment, before any node runs. Returns an empty
 * array when the graph is clean (including "no secrets used at all").
 */
export function validateSecretReferences(doc: FlowDocument, env: Readonly<Record<string, string | undefined>>): SecretValidationError[] {
  const declared = declaredSecrets(doc);
  const errors: SecretValidationError[] = [];
  for (const ref of referencedSecrets(doc)) {
    if (!declared.has(ref.name)) {
      errors.push({
        nodeId: ref.nodeId,
        param: ref.param,
        name: ref.name,
        reason: 'undeclared',
        message: `node "${ref.nodeId}" param "${ref.param}" references {{secret:${ref.name}}}, but the graph does not declare "secret.read:${ref.name}"`,
      });
      continue;
    }
    if (env[ref.name] === undefined) {
      errors.push({
        nodeId: ref.nodeId,
        param: ref.param,
        name: ref.name,
        reason: 'unset',
        message: `node "${ref.nodeId}" param "${ref.param}" references {{secret:${ref.name}}}, which is declared but not set in the environment`,
      });
    }
  }
  return errors;
}

/** Resolve every declared-and-referenced secret's value from `env`. Call only after `validateSecretReferences` returns no errors. */
export function resolveSecretValues(doc: FlowDocument, env: Readonly<Record<string, string | undefined>>): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  for (const ref of referencedSecrets(doc)) {
    const v = env[ref.name];
    if (v === undefined) continue;
    // Redaction is a substring scrub, and a very short value cannot be
    // scrubbed without mangling ordinary output — so rather than resolve a
    // secret that would then travel unredacted, refuse it. The message names
    // the variable, never the value.
    if (v.length < MIN_REDACTED_SECRET_LENGTH) {
      throw new Error(
        `secret ${ref.name} is shorter than ${MIN_REDACTED_SECRET_LENGTH} characters, so it could not be `
        + 'redacted from run output; refusing to use it',
      );
    }
    values.set(ref.name, v);
  }
  return values;
}

function substitute(value: unknown, values: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') {
    return replaceSecretRefs(value, (name, whole) => values.get(name) ?? whole);
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, values));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, values)]));
  }
  return value;
}

/** Return a new document with every `{{secret:NAME}}` reference in node params replaced by its resolved value. The input document is never mutated. */
export function interpolateSecrets(doc: FlowDocument, values: ReadonlyMap<string, string>): FlowDocument {
  if (values.size === 0) return doc;
  const nodes: FlowNode[] = doc.nodes.map((node) => {
    if (!node.params) return node;
    const params = Object.fromEntries(Object.entries(node.params).map(([k, v]) => [k, substitute(v, values)]));
    return { ...node, params };
  });
  return { ...doc, nodes };
}

/** Minimum secret length worth redacting (see module doc): shorter values risk mass-redacting incidental substrings of ordinary text. */
export const MIN_REDACTED_SECRET_LENGTH = 6;

/**
 * Reverse map (value → marker) for every resolved secret at least
 * `MIN_REDACTED_SECRET_LENGTH` characters long. A secret shorter than
 * that is a real gap (documented, not silently accepted): a 4-character
 * token could coincide with ordinary text often enough that scrubbing it
 * everywhere would make legitimate output unreadable, so this module
 * accepts that a very short secret is not redactable by substring match
 * at all.
 */
export function buildRedactionMap(values: ReadonlyMap<string, string>): ReadonlyMap<string, string> {
  // Secrets sharing one value share one marker naming all of them, rather
  // than the last silently taking the value over (#5446 review).
  const names = new Map<string, string[]>();
  for (const [name, value] of values) {
    if (value.length < MIN_REDACTED_SECRET_LENGTH) continue;
    names.set(value, [...(names.get(value) ?? []), name]);
  }
  // Longest value first, so a secret containing another is matched whole.
  const ordered = [...names].sort(([a], [b]) => b.length - a.length);
  return new Map(ordered.map(([value, owners]) => [value, `<secret:${[...owners].sort().join('|')}>`]));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace every occurrence of a redacted secret value with its marker, in ONE
 * pass, trying the longest value first at each position. Sequential
 * replacement let a shorter secret inside a longer one match first
 * (`abcdef` inside `abcdefghi` left `<secret:A>ghi`, exposing B's suffix),
 * and could match inside a marker already written (#5446 review).
 */
export function redactText(text: string, redaction: ReadonlyMap<string, string>): string {
  if (redaction.size === 0) return text;
  const values = [...redaction.keys()].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(values.map(escapeRegExp).join('|'), 'g');
  return text.replace(pattern, (match) => redaction.get(match) ?? match);
}

/**
 * Walk an arbitrary JSON-ish value (a run summary, a log entry, a thrown
 * error's message) and redact every string found, at any depth — this is
 * what catches a secret that travelled through a response body and back
 * into the run's own output, not just the literal param it was
 * interpolated into.
 */
/**
 * The env names a host may report as available secrets: set, and long
 * enough to be redacted. `resolveSecretValues` refuses a shorter value, so
 * counting it as available made `flow validate` pass a graph the run then
 * refused (#5446 review).
 */
export function usableSecretNames(env: Readonly<Record<string, string | undefined>>): string[] {
  return Object.entries(env)
    .filter(([, value]) => typeof value === 'string' && value.length >= MIN_REDACTED_SECRET_LENGTH)
    .map(([name]) => name);
}

export function redactDeep<T>(value: T, redaction: ReadonlyMap<string, string>): T {
  if (redaction.size === 0) return value;
  if (typeof value === 'string') return redactText(value, redaction) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redaction)) as unknown as T;
  // Keys too: a script can return an object keyed by a secret, and
  // `core.groupBy` can group by one (#5446 review).
  if (value instanceof Map) {
    return new Map([...value.entries()].map(([k, v]) => [redactDeep(k, redaction), redactDeep(v, redaction)])) as unknown as T;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [redactText(k, redaction), redactDeep(v, redaction)]),
    ) as unknown as T;
  }
  return value;
}
