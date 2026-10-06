/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared strict-parsing helpers for the reviewed check-authoring proposals
 * (viewer AI P07, #6915): `ids.specifications`, `rules.proposal` and
 * `document.outline`. Every refusal names the field and what to change, so
 * the assistant's "ask again" correction carries an actionable reason.
 */

export type CheckAuthoringKind = 'ids.specifications' | 'rules.proposal' | 'document.outline';
export const CHECK_AUTHORING_KINDS: readonly CheckAuthoringKind[] = ['ids.specifications', 'rules.proposal', 'document.outline'];

export const ANSWER_LIMIT = 200_000;
export const TEXT_LIMIT = 2000;

export type JsonRecord = Record<string, unknown>;

export const isRecord = (value: unknown): value is JsonRecord =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Non-empty text within `max` characters. */
export const isText = (value: unknown, max = 200): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max;

/** Refuse fields the contract does not define instead of ignoring them. */
export function onlyKeys(value: JsonRecord, allowed: readonly string[], at: string): void {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length) throw new Error(`${at} has unsupported field(s) ${unknown.join(', ')}; allowed: ${allowed.join(', ')}`);
}

/** Control characters other than tab and line breaks: XML 1.0 cannot carry them, so a saved IDS could not either. */
export function plainText(text: string, at: string): string {
  // Matching control characters is the point: they are refused, not allowed through.
  // eslint-disable-next-line no-control-regex
  const bad = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.exec(text);
  if (bad) throw new Error(`${at} contains a control character (U+${bad[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}); remove it`);
  return text;
}

export function optionalText(value: JsonRecord, key: string, at: string, max = TEXT_LIMIT): string | undefined {
  if (value[key] === undefined) return undefined;
  if (!isText(value[key], max)) throw new Error(`${at}.${key} must be non-empty text of at most ${max} characters`);
  return plainText((value[key] as string).trim(), `${at}.${key}`);
}

export function requiredText(value: JsonRecord, key: string, at: string, max = 200): string {
  if (!isText(value[key], max)) throw new Error(`${at}.${key} is required: non-empty text of at most ${max} characters`);
  return plainText((value[key] as string).trim(), `${at}.${key}`);
}

/** Which typed kind a reply declares, if any. Prose never reaches the strict parsers. */
export function declaredCheckKind(content: string): CheckAuthoringKind | null {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('```')) return null;
  const kind = /"kind"\s*:\s*"(ids\.specifications|rules\.proposal|document\.outline)"/.exec(content)?.[1];
  return kind ? kind as CheckAuthoringKind : null;
}

/** A complete JSON answer (optionally fenced) of the given kind and version 1. */
export function parseProposalEnvelope(answer: string, kind: CheckAuthoringKind): JsonRecord {
  if (answer.length > ANSWER_LIMIT) throw new Error(`The ${kind} proposal exceeds the ${ANSWER_LIMIT}-character limit; propose fewer items`);
  const trimmed = answer.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed);
  let value: unknown;
  try { value = JSON.parse(fenced ? fenced[1] : trimmed); }
  catch (error) {
    throw new Error(`The ${kind} proposal is not complete JSON (${error instanceof Error ? error.message : String(error)}); return only the JSON object`);
  }
  if (!isRecord(value) || value.kind !== kind) throw new Error(`Not a ${kind} proposal`);
  if (value.version !== 1) throw new Error(`A ${kind} proposal must declare "version": 1`);
  return value;
}

/** A requirement no native engine here can check, kept visible and stored with the draft. */
export interface UnsupportedRequirement {
  /** The requirement as stated by the user or source document. */
  text: string;
  /** Why no native check covers it (e.g. geometry, free text, manual inspection). */
  reason: string;
  /** Name of the related specification, rule or section, when there is one. */
  relatesTo?: string;
}

export const UNSUPPORTED_LIMIT = 50;

export function parseUnsupported(value: unknown): UnsupportedRequirement[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('"unsupported" must be a list of {text, reason, relatesTo?} items');
  if (value.length > UNSUPPORTED_LIMIT) throw new Error(`At most ${UNSUPPORTED_LIMIT} unsupported requirements may be listed`);
  return value.map((item, index) => {
    const at = `unsupported[${index}]`;
    if (!isRecord(item)) throw new Error(`${at} must be an object {text, reason, relatesTo?}`);
    onlyKeys(item, ['text', 'reason', 'relatesTo'], at);
    const relatesTo = optionalText(item, 'relatesTo', at, 200);
    return { text: requiredText(item, 'text', at, TEXT_LIMIT), reason: requiredText(item, 'reason', at, 500), ...(relatesTo ? { relatesTo } : {}) };
  });
}

/** The plain-text note stored with a saved draft: every unsupported item, numbered. */
export function unsupportedNote(items: readonly UnsupportedRequirement[]): string {
  if (!items.length) return '';
  return ['Not checked (no native check available; review manually):',
    ...items.map((item, index) => `${index + 1}. ${item.text} (${item.reason}${item.relatesTo ? `; ${item.relatesTo}` : ''})`)].join('\n');
}

