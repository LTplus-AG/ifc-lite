/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared strict-parse helpers for the assistant's native artifact proposals
 * (viewer AI P13): `filter.proposal`, `list.proposal`, `lens.proposal` and
 * `chart.proposal`. Each proposal carries the native definition type of its
 * engine (Rules `FilterGroup`, `ListDefinition`, `Lens`, `ChartSpec`); these
 * helpers only read the envelope and refuse anything a person could not act
 * on. Nothing here runs an engine or writes.
 */

export const ARTIFACT_KINDS = ['filter.proposal', 'list.proposal', 'lens.proposal', 'chart.proposal'] as const;
export type ArtifactKind = typeof ARTIFACT_KINDS[number];

/** Short, human-facing text bound (names, titles). */
export const NAME_LIMIT = 80;
const RATIONALE_LIMIT = 2000;
const ANSWER_LIMIT = 200_000;

export const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export const text = (value: unknown, max = NAME_LIMIT): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max;

/** Refuse keys the contract does not name, so a misspelt field is never silently ignored. */
export function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], at: string): void {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length > 0) throw new Error(`${at} has unsupported field${extra.length > 1 ? 's' : ''} ${extra.map((k) => `"${k}"`).join(', ')}; allowed: ${allowed.join(', ')}`);
}

export function requiredText(value: unknown, at: string, max = NAME_LIMIT): string {
  if (!text(value, max)) throw new Error(`${at} must be non-empty text of at most ${max} characters`);
  return value.trim();
}

export interface ArtifactEnvelope {
  version: 1;
  title: string;
  rationale?: string;
}

export type NativeArtifactScope = 'all' | 'selected' | 'visible';
export function parseNativeArtifactScope(value: unknown): NativeArtifactScope | undefined {
  if (value === undefined) return undefined;
  if (value !== 'all' && value !== 'selected' && value !== 'visible') throw new Error('The artifact scope must be all, selected, or visible.');
  return value;
}

/**
 * Parse a complete JSON answer (optionally one fenced block) declaring `kind`.
 * Returns the raw object plus the common envelope; the caller reads its own body.
 */
export function parseEnvelope(answer: string, kind: ArtifactKind, bodyKeys: readonly string[]): { value: Record<string, unknown>; envelope: ArtifactEnvelope } {
  if (answer.length > ANSWER_LIMIT) throw new Error('The proposal exceeds the text limit');
  const trimmed = answer.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed);
  let value: unknown;
  try { value = JSON.parse(fenced ? fenced[1] : trimmed); }
  catch (error) { throw new Error(`The proposal is not one complete JSON object (${error instanceof Error ? error.message : String(error)})`); }
  if (!record(value) || value.kind !== kind) throw new Error(`Not a ${kind}`);
  if (value.version !== 1) throw new Error(`A ${kind} must declare "version": 1`);
  // Only a chart carries a scope (its dashboard's). A saved filter, list or lens cannot hold runtime visibility or selection,
  // so a proposal claiming one is refused instead of silently running over everything.
  if (value.scope !== undefined && !bodyKeys.includes('scope')) {
    throw new Error(`A ${kind} runs over every loaded model, or the models a "model" rule names; "visible" and "selected" are not part of it. `
      + 'Ask for a chart in the visible or basket scope instead, or select the result from the Filter tab.');
  }
  onlyKeys(value, ['version', 'kind', 'title', 'rationale', ...bodyKeys], `The ${kind}`);
  const title = requiredText(value.title, 'The title');
  if (value.rationale !== undefined && !text(value.rationale, RATIONALE_LIMIT)) throw new Error('The rationale must be text');
  return { value, envelope: { version: 1, title, ...(typeof value.rationale === 'string' ? { rationale: value.rationale } : {}) } };
}

/** A `#RRGGBB` colour, the form the Lens editor stores. */
export function parseHexColor(value: unknown, at: string): string {
  if (typeof value !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(value)) throw new Error(`${at} must be a #RRGGBB colour`);
  return value.toUpperCase();
}
