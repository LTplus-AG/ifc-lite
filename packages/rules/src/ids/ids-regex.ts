/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regex translation between a rule's `matches` operand (a JavaScript regex,
 * searched UNANCHORED, see `filter-ops.ts`'s `regexOpMatches`) and an IDS
 * `xs:pattern` (an XSD regex, matched against the WHOLE value) (#5225).
 *
 * The two dialects share most syntax, so each direction walks the pattern
 * and either rewrites a construct into its exact counterpart or refuses the
 * pattern with the construct named. It never approximates: a pattern that
 * means something different in the other dialect is a refusal, not a
 * best-effort translation.
 */

import { translateXsdRegex } from '@ifc-lite/ids';

export type RegexConversion =
  | { ok: true; pattern: string }
  | { ok: false; reason: string };

/** Characters that must be escaped to stand for themselves in an XSD regex. */
const XSD_META = new Set(['\\', '|', '.', '?', '*', '+', '(', ')', '{', '}', '[', ']', '^', '$', '-']);

/** `text` as an XSD regex matching exactly that text. */
export function escapeXsdLiteral(text: string): string {
  let out = '';
  for (const ch of text) out += XSD_META.has(ch) ? `\\${ch}` : ch;
  return out;
}

/** A JS regex as the engine reads it: the source plus its flags. */
export interface JsRegex {
  source: string;
  flags: string;
}

/**
 * The regex a `matches` operand stands for, following `regexOpMatches`:
 * `valueKind: 'regex'` means the whole string is the source; no kind means
 * a `/body/flags` literal is a pattern and anything else is a bare source.
 */
export function jsRegexOf(value: string, valueKind: 'regex' | 'literal' | undefined): JsRegex {
  if (valueKind === undefined) {
    const literal = /^\/(.+)\/([a-z]*)$/.exec(value);
    if (literal) return { source: literal[1], flags: literal[2] };
  }
  return { source: value, flags: '' };
}

/** Index of every `|` at nesting depth 0, outside character classes. */
function hasTopLevelAlternation(source: string): boolean {
  let depth = 0;
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\\') { i++; continue; }
    if (inClass) { if (ch === ']') inClass = false; continue; }
    if (ch === '[') inClass = true;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === '|' && depth === 0) return true;
  }
  return false;
}

/** `^(?:X)$` → `X`, when the group really spans the whole source. */
function unwrapAnchoredGroup(source: string): string | null {
  if (!source.startsWith('^(?:') || !source.endsWith(')$')) return null;
  const inner = source.slice(4, -2);
  // The `)` before `$` must close the `(?:` opened at index 1.
  let depth = 0;
  let inClass = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '\\') { i++; continue; }
    if (inClass) { if (ch === ']') inClass = false; continue; }
    if (ch === '[') inClass = true;
    else if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth < 0) return null; }
  }
  return depth === 0 ? inner : null;
}

const QUANTIFIER_END = new Set(['*', '+', '?', '}']);

/** Rewrite a JS regex body (no anchors) into XSD syntax, or say why not. */
function jsBodyToXsd(body: string, unicode: boolean): RegexConversion {
  let out = '';
  let inClass = false;
  let classStart = false;
  let afterQuantifier = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    const wasAfterQuantifier = afterQuantifier;
    afterQuantifier = false;
    if (ch === '\\') {
      const next = body[i + 1];
      if (next === undefined) return { ok: false, reason: 'the pattern ends in a lone backslash' };
      i++;
      classStart = false;
      if (next === 'd') { out += inClass ? '0-9' : '[0-9]'; continue; }
      if (next === 'D') {
        if (inClass) return { ok: false, reason: '\\D inside a character class has no XSD form' };
        out += '[^0-9]';
        continue;
      }
      if ('wWsSbB'.includes(next)) {
        return { ok: false, reason: `\\${next} means something different in an IDS (XSD) pattern` };
      }
      if ((next === 'p' || next === 'P') && unicode) {
        const m = /^\{([A-Z][a-z]?)\}/.exec(body.slice(i + 1));
        if (!m) return { ok: false, reason: `the Unicode property escape at \\${next} has no XSD form` };
        out += `\\${next}{${m[1]}}`;
        i += m[0].length;
        continue;
      }
      if (next === 'n' || next === 'r' || next === 't') { out += `\\${next}`; continue; }
      if (/[0-9]/.test(next)) return { ok: false, reason: 'back-references are not supported by IDS (XSD) patterns' };
      if (/[a-zA-Z]/.test(next)) {
        if (unicode) return { ok: false, reason: `the escape \\${next} has no XSD form` };
        // Without the `u` flag an unknown letter escape is the letter itself.
        if ('xucfvk'.includes(next)) return { ok: false, reason: `the escape \\${next} has no XSD form` };
        out += next;
        continue;
      }
      out += XSD_META.has(next) ? `\\${next}` : next;
      continue;
    }
    if (inClass) {
      if (ch === ']' && !classStart) { inClass = false; out += ch; continue; }
      if (ch === '[') { out += '\\['; classStart = false; continue; }
      if (ch === '^' && classStart) { out += ch; continue; }
      classStart = false;
      out += ch;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      classStart = true;
      out += ch;
      continue;
    }
    if (ch === '(' && body[i + 1] === '?') {
      return { ok: false, reason: 'groups starting "(?" (lookaround, named or non-capturing) are not supported by IDS (XSD) patterns' };
    }
    if (ch === '^' || ch === '$') {
      return { ok: false, reason: `"${ch}" is only supported at the very start or end of the pattern` };
    }
    if (ch === '?' && wasAfterQuantifier) {
      return { ok: false, reason: 'lazy quantifiers are not supported by IDS (XSD) patterns' };
    }
    if (QUANTIFIER_END.has(ch)) afterQuantifier = true;
    out += ch;
  }
  if (inClass) return { ok: false, reason: 'the pattern has an unterminated character class' };
  return { ok: true, pattern: out };
}

/** Whether `xsd` compiles, through the same translator the IDS checker uses. */
function xsdCompiles(xsd: string): boolean {
  const translated = translateXsdRegex(xsd);
  if (!translated.supported) return false;
  try {
    new RegExp(`^(?:${translated.pattern})$`, 'u');
    return true;
  } catch {
    return false;
  }
}

/**
 * Translate the engine's unanchored JS regex into an IDS pattern that
 * accepts exactly the same values. `^…$` anchors (or the `^(?:…)$` wrapper
 * `idsPatternToJsRegex` produces) become the XSD pattern's implicit whole-
 * value match; an unanchored side becomes `.*`.
 */
export function jsRegexToIdsPattern(regex: JsRegex): RegexConversion {
  // `g` and `y` are dropped because the engine drops them: `@ifc-lite/lists`'
  // `parseRegexLiteral` compiles every operand without them (a cached,
  // shared matcher must not carry `lastIndex` state), so `/a/y` already
  // searches like `/a/`. `d` only adds match indices.
  const flags = regex.flags.replace(/[gyd]/g, '');
  for (const flag of flags) {
    if (flag === 'i') return { ok: false, reason: 'the "i" flag makes the pattern case-insensitive, which IDS patterns cannot be' };
    if (flag !== 'u') return { ok: false, reason: `the "${flag}" regex flag has no IDS (XSD) equivalent` };
  }
  const unicode = flags.includes('u');

  const wrapped = unwrapAnchoredGroup(regex.source);
  let body = wrapped ?? regex.source;
  let anchoredStart = wrapped !== null;
  let anchoredEnd = wrapped !== null;
  if (wrapped === null) {
    anchoredStart = body.startsWith('^');
    // A trailing `$` is an anchor unless it is escaped (`\$`).
    anchoredEnd = body.endsWith('$') && !/(^|[^\\])(\\\\)*\\\$$/.test(body);
    if ((anchoredStart || anchoredEnd) && hasTopLevelAlternation(body)) {
      return { ok: false, reason: 'anchors combined with a top-level "|" have no single IDS pattern' };
    }
    if (anchoredStart) body = body.slice(1);
    if (anchoredEnd) body = body.slice(0, -1);
  }
  if (body.length === 0) return { ok: false, reason: 'the pattern is empty' };

  const converted = jsBodyToXsd(body, unicode);
  if (!converted.ok) return converted;

  const needsGroup = !(anchoredStart && anchoredEnd) && hasTopLevelAlternation(converted.pattern);
  const core = needsGroup ? `(${converted.pattern})` : converted.pattern;
  const pattern = `${anchoredStart ? '' : '.*'}${core}${anchoredEnd ? '' : '.*'}`;
  if (!xsdCompiles(pattern)) return { ok: false, reason: 'the translated pattern is not a valid IDS (XSD) pattern' };
  return { ok: true, pattern };
}

/**
 * Translate an IDS pattern into the rule operand that accepts the same
 * values: a `/^(?:…)$/u` literal (the `u` flag because XSD's `\d`, `\i`,
 * `\c` and `\w` translate to Unicode property escapes). XSD's `^` and `$`
 * are ordinary characters, so they are escaped first.
 */
export function idsPatternToJsRegex(xsd: string): RegexConversion {
  let literalAnchors = '';
  let inClass = false;
  let classStart = false;
  for (let i = 0; i < xsd.length; i++) {
    const ch = xsd[i];
    if (ch === '\\') { literalAnchors += ch + (xsd[i + 1] ?? ''); i++; classStart = false; continue; }
    if (inClass) {
      if (ch === ']' && !classStart) inClass = false;
      classStart = false;
      literalAnchors += ch;
      continue;
    }
    if (ch === '[') { inClass = true; classStart = true; literalAnchors += ch; continue; }
    literalAnchors += ch === '^' || ch === '$' ? `\\${ch}` : ch;
  }
  const translated = translateXsdRegex(literalAnchors);
  if (!translated.supported) return { ok: false, reason: translated.reason };
  const source = `^(?:${translated.pattern})$`;
  try {
    new RegExp(source, 'u');
  } catch (err) {
    return { ok: false, reason: `the pattern does not compile: ${(err as Error).message}` };
  }
  return { ok: true, pattern: `/${source}/u` };
}
