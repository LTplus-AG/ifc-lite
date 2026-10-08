/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared strict envelope for semantic assistant proposals (viewer AI P16).
 * A proposal is a complete JSON answer (optionally fenced); anything else is
 * refused with a reason a person can act on. Nothing here executes or writes.
 */

export const SEMANTIC_PROPOSAL_KINDS = ['semantic.query', 'semantic.mapping', 'semantic.projection', 'semantic.requirements'] as const;
export type SemanticProposalKind = typeof SEMANTIC_PROPOSAL_KINDS[number];

/** A quoted passage of an attached source text: UTF-16 offsets, end exclusive. */
export interface SourceSpan { source: string; start: number; end: number; quote: string }

export const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
export const text = (value: unknown, max = 200): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max;

/** Refuse unknown keys so a typo never silently drops a reviewer-visible field. */
export function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], at: string): void {
  const extra = Object.keys(value).find(key => !allowed.includes(key));
  if (extra) throw new Error(`${at} has an unsupported field "${extra}"`);
}

/** Parse the bounded envelope of one declared kind. */
export function parseEnvelope(answer: string, kind: SemanticProposalKind, allowed: readonly string[]): Record<string, unknown> {
  if (answer.length > 200_000) throw new Error('The proposal exceeds the text limit');
  const trimmed = answer.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed);
  let value: unknown;
  try { value = JSON.parse(fenced ? fenced[1] : trimmed); }
  catch { throw new Error('The proposal is not one complete JSON object'); }
  if (!record(value) || value.kind !== kind) throw new Error(`Not a ${kind} proposal`);
  if (value.version !== 1) throw new Error('The proposal must declare "version": 1');
  onlyKeys(value, ['version', 'kind', 'title', ...allowed], 'The proposal');
  if (!text(value.title, 120)) throw new Error('The proposal needs a short title');
  return value;
}

export function parseSpan(value: unknown, at: string): SourceSpan {
  if (!record(value)) throw new Error(`${at} needs a source span object`);
  onlyKeys(value, ['source', 'start', 'end', 'quote'], at);
  if (typeof value.source !== 'string' || !/^S[1-9]\d?$/.test(value.source)) throw new Error(`${at} must name an attached source such as "S1"`);
  if (!Number.isSafeInteger(value.start) || !Number.isSafeInteger(value.end) || (value.start as number) < 0
    || (value.end as number) <= (value.start as number)) throw new Error(`${at} needs integer offsets with start < end`);
  if (typeof value.quote !== 'string' || !value.quote.length || value.quote.length > 2000) throw new Error(`${at} must quote the exact source text`);
  return { source: value.source, start: value.start as number, end: value.end as number, quote: value.quote };
}

/** Proposals the assistant flags as unsupported or ambiguous are retained, never dropped. */
export interface UnsupportedItem { text: string; reason: string; span?: SourceSpan }
export function parseUnsupported(value: unknown): UnsupportedItem[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) throw new Error('"unsupported" must be a list of at most 100 items');
  return value.map((item, index) => {
    const at = `Unsupported item ${index + 1}`;
    if (!record(item)) throw new Error(`${at} is not an object`);
    onlyKeys(item, ['text', 'reason', 'span'], at);
    if (!text(item.text, 2000) || !text(item.reason, 600)) throw new Error(`${at} needs the text and a reason`);
    return { text: item.text, reason: item.reason, ...(item.span === undefined ? {} : { span: parseSpan(item.span, at) }) };
  });
}

/** Kind declared by a reply, without parsing prose. */
export function declaredSemanticKind(content: string): SemanticProposalKind | null {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('```')) return null;
  const kind = /"kind"\s*:\s*"(semantic\.(?:query|mapping|projection|requirements))"/.exec(content)?.[1];
  return SEMANTIC_PROPOSAL_KINDS.find(candidate => candidate === kind) ?? null;
}
