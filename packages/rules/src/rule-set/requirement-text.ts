/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Text form for `unique`/`aggregate`/`compare` requirements (#5138 §6):
 * `unique(Name)`, `count() >= 1 by parent`, `sum(Qto_X.NetFloorArea) > 300`,
 * `Pset_X.End > Pset_X.Start date`. NOT IfcOpenShell selector syntax — a
 * small recursive-descent grammar apart from `packages/query`/
 * `selector-to-rules.ts`. `element` requirements are out of scope here.
 */
import type { Subject, UniqueRequirement, AggregateRequirement, CompareRequirement } from './rule-set.js';
import type { NumericOp } from '../filter/filter-rules.js';
import { checkAggregateSubject, checkCompareSubjects } from './requirement-invariants.js';

export type TextRequirement = UniqueRequirement | AggregateRequirement | CompareRequirement;
export type RequirementTextResult = { ok: true; requirement: TextRequirement } | { ok: false; error: string };
type BareSubjectKind = 'name' | 'type' | 'parent' | 'storey' | 'material' | 'globalId' | 'predefinedType' | 'ifcType';
const BARE_KINDS: Record<string, BareSubjectKind> = {
  Name: 'name', type: 'type', parent: 'parent', storey: 'storey',
  material: 'material', globalId: 'globalId', predefinedType: 'predefinedType', ifcType: 'ifcType',
};
const OP_TEXT: Record<NumericOp, string> = { eq: '=', ne: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' };
const TEXT_OP: Record<string, NumericOp> = { '=': 'eq', '!=': 'ne', '>=': 'gte', '<=': 'lte', '>': 'gt', '<': 'lt' };
const quoted = (name: string): string => (/^[^\s."()>=<!]+$/.test(name) ? name : `"${name}"`);
function subjectToText(s: Subject): string {
  if (s.kind === 'attribute') return quoted(s.name);
  if (s.kind === 'property') return `${quoted(s.setName)}.${quoted(s.propertyName)}`;
  if (s.kind === 'quantity') return `${quoted(s.setName)}.${quoted(s.quantityName)}`;
  // System-scoped classification has no text spelling (kept out of this
  // ~20-line grammar per plan §6); `system` is dropped, never guessed back.
  if (s.kind === 'classification') return 'classification';
  return Object.entries(BARE_KINDS).find(([, kind]) => kind === s.kind)?.[0] ?? s.kind;
}
export function requirementToText(req: TextRequirement): string {
  if (req.kind === 'unique') {
    return `unique(${subjectToText(req.subject)})${req.scope === 'perModel' ? ' perModel' : ''}`;
  }
  if (req.kind === 'aggregate') {
    const subject = req.subject ? subjectToText(req.subject) : '';
    const by = req.groupBy ? ` by ${subjectToText(req.groupBy.subject)}` : '';
    return `${req.fn}(${subject}) ${OP_TEXT[req.op]} ${req.value}${by}`;
  }
  const date = req.valueType === 'date' ? ' date' : '';
  return `${subjectToText(req.left)} ${OP_TEXT[req.op]} ${subjectToText(req.right)}${date}`;
}
// Parser below: index-based, no token array. Every failure throws `TextError`,
// caught once in `parseRequirementText`.
class TextError extends Error {}
/** A quoted string, or a run of non-punctuation chars. */
function readSegment(s: string, i: number): [string, number] {
  if (s[i] === '"') {
    const end = s.indexOf('"', i + 1);
    if (end < 0) throw new TextError(`unterminated quote at ${JSON.stringify(s.slice(i))}`);
    return [s.slice(i + 1, end), end + 1];
  }
  const m = /^[^\s."()>=<!]+/.exec(s.slice(i));
  if (!m) throw new TextError(`expected a name at ${JSON.stringify(s.slice(i))}`);
  return [m[0], i + m[0].length];
}
function skipWs(s: string, i: number): number {
  while (s[i] === ' ') i += 1;
  return i;
}
function parseSubject(s: string, i: number): [Subject, number] {
  i = skipWs(s, i);
  const [seg, j] = readSegment(s, i);
  if (s[j] === '.') {
    const [seg2, k] = readSegment(s, j + 1);
    // `Qto_…` names the QUANTITY table (selector adapter's `looksLikeQuantitySet`).
    const subject: Subject = seg.startsWith('Qto_')
      ? { kind: 'quantity', setName: seg, quantityName: seg2 }
      : { kind: 'property', setName: seg, propertyName: seg2 };
    return [subject, k];
  }
  if (seg in BARE_KINDS) return [{ kind: BARE_KINDS[seg] }, j];
  if (seg === 'classification') return [{ kind: 'classification' }, j];
  return [{ kind: 'attribute', name: seg }, j];
}
function parseOp(s: string, i: number): [NumericOp, number] {
  i = skipWs(s, i);
  const two = s.slice(i, i + 2);
  if (two === '>=' || two === '<=' || two === '!=') return [TEXT_OP[two], i + 2];
  const one = s[i];
  if (one === '=' || one === '>' || one === '<') return [TEXT_OP[one], i + 1];
  throw new TextError(`expected an operator at ${JSON.stringify(s.slice(i))}`);
}
function parseNumber(s: string, i: number): [number, number] {
  i = skipWs(s, i);
  const m = /^-?\d+(\.\d+)?/.exec(s.slice(i));
  if (!m) throw new TextError(`expected a number at ${JSON.stringify(s.slice(i))}`);
  return [Number.parseFloat(m[0]), i + m[0].length];
}
function parenSpan(s: string, fn: string): [number, number] {
  const open = s.indexOf('(');
  const close = s.indexOf(')', open);
  if (open < 0 || close < 0) throw new TextError(`expected "${fn}(...)" in ${JSON.stringify(s)}`);
  return [open, close];
}
/** The whole `(...)` body must be one subject — `sum(Foo Bar)` used to parse
 *  `Foo` and silently drop `Bar` (review on #5144). */
function parseParenSubject(s: string, open: number, close: number): Subject {
  const [subject, end] = parseSubject(s, open + 1);
  const leftover = s.slice(end, close).trim();
  if (leftover !== '') throw new TextError(`unexpected ${JSON.stringify(leftover)} inside the parentheses`);
  return subject;
}
function parseUnique(s: string): UniqueRequirement {
  const [open, close] = parenSpan(s, 'unique');
  const subject = parseParenSubject(s, open, close);
  const rest = s.slice(close + 1).trim();
  if (rest === '') return { kind: 'unique', subject };
  if (rest === 'perModel') return { kind: 'unique', subject, scope: 'perModel' };
  throw new TextError(`unexpected trailing text ${JSON.stringify(rest)}`);
}
function parseAggregate(s: string, fn: AggregateRequirement['fn']): AggregateRequirement {
  const [open, close] = parenSpan(s, fn);
  const inner = s.slice(open + 1, close).trim();
  const subject = inner === '' ? undefined : parseParenSubject(s, open, close);
  // Shared with the JSON parser (#5182) — same two invariants, same
  // wording, checked before the requirement is returned so the text and
  // JSON authoring paths can't drift on what they accept.
  const subjectError = checkAggregateSubject(fn, subject);
  if (subjectError) throw new TextError(subjectError);
  const [op, afterOp] = parseOp(s, close + 1);
  const [value, afterValue] = parseNumber(s, afterOp);
  let i = afterValue;
  let groupBy: AggregateRequirement['groupBy'];
  const byMatch = /^\s*by\s+/.exec(s.slice(i));
  if (byMatch) {
    i += byMatch[0].length;
    const [gs, j] = parseSubject(s, i);
    groupBy = { subject: gs };
    i = j;
  }
  const trailing = s.slice(i).trim();
  if (trailing !== '') throw new TextError(`unexpected trailing text ${JSON.stringify(trailing)}`);
  return { kind: 'aggregate', fn, ...(subject ? { subject } : {}), ...(groupBy ? { groupBy } : {}), op, value };
}
function parseCompare(s: string): CompareRequirement {
  const [left, afterLeft] = parseSubject(s, 0);
  const [op, afterOp] = parseOp(s, afterLeft);
  const [right, afterRight] = parseSubject(s, afterOp);
  const sideError = checkCompareSubjects(left, right);
  if (sideError) throw new TextError(`${sideError.side}: ${sideError.message}`);
  const trailing = s.slice(afterRight).trim();
  if (trailing === '') return { kind: 'compare', left, right, op };
  if (trailing === 'date') return { kind: 'compare', left, right, op, valueType: 'date' };
  throw new TextError(`unexpected trailing text ${JSON.stringify(trailing)}`);
}
/** Parses one requirement-text line; a bad token comes back as `{ ok: false, error }`. */
export function parseRequirementText(text: string): RequirementTextResult {
  const s = text.trim();
  try {
    if (s.startsWith('unique(')) return { ok: true, requirement: parseUnique(s) };
    const fn = /^(count|sum|min|max|avg)\s*\(/.exec(s);
    if (fn) return { ok: true, requirement: parseAggregate(s, fn[1] as AggregateRequirement['fn']) };
    return { ok: true, requirement: parseCompare(s) };
  } catch (err) {
    return { ok: false, error: err instanceof TextError ? err.message : `Failed to parse: ${(err as Error).message}` };
  }
}
