/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Give every entity instance in a STEP file a new instance name (`#id`) from a
 * seeded permutation, and rewrite every reference to match.
 *
 * Instance names only identify an instance within one file; they carry no
 * meaning and exporters renumber freely. This makes that visible and testable:
 * teaching material can show that `#id`s change while GlobalIds do not, and
 * test corpora can check that a consumer never depends on `#id` values or on
 * instance order.
 *
 * Reference rewriting is `remapEntityText` (the merged exporter's rule): only
 * `#digits` tokens outside string literals change, so `'Room #205'` survives.
 * Statements are split at `;` outside string literals (`stepStringLiteralEnd`,
 * which also honours the `\S\'` PAGE operand) and outside comments. References
 * are rewritten in DATA records and in the edition-3 ANCHOR and REFERENCE
 * sections; REFERENCE entries (`#12=<uri>;`) declare instance names like DATA
 * records do. The HEADER, comments and `<...>` resource literals (anchor names,
 * URIs such as `<http://x#12>`) are copied verbatim, so a `#digits` inside them
 * is neither a reference nor rewritten.
 */

import { stepStringLiteralEnd, type RandomSource } from '@ifc-lite/encoding';
import { remapEntityText } from './merged-remap.js';

export interface RenumberStepIdsOptions {
  /** Source of the permutation, e.g. a seeded `() => number` in [0, 1). Same source, same output. */
  random: RandomSource;
  /** Also shuffle the order of the instances within each DATA section. Default false: order kept, ids changed. */
  reorder?: boolean;
}

export interface RenumberStepIdsResult {
  text: string;
  /** Old instance name -> new instance name, for every instance in the file. */
  idMap: Map<number, number>;
  /** References to instance names no instance in the file declares; left as they were. */
  danglingReferences: number[];
}

interface Statement {
  start: number;
  /** Index just past the `;`. */
  end: number;
}

/** Statements (`...;`) in `text`, split outside string literals and `/* *\/` comments. */
function splitStatements(text: string): Statement[] {
  const out: Statement[] = [];
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === 0x27 /* ' */) {
      const end = stepStringLiteralEnd(text, i);
      if (end === -1) throw new Error(`renumberStepIds: unterminated string literal at offset ${i}`);
      i = end;
      continue;
    }
    if (c === 0x2f /* / */ && text.charCodeAt(i + 1) === 0x2a /* * */) {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) throw new Error(`renumberStepIds: unterminated comment at offset ${i}`);
      i = end + 2;
      continue;
    }
    if (c === 0x3b /* ; */) {
      out.push({ start, end: i + 1 });
      start = i + 1;
    }
    i++;
  }
  return out;
}

/** The statement's keyword after leading whitespace and comments, e.g. `DATA`, `ENDSEC`, or `#` for a record. */
function leadingToken(text: string): string {
  const t = text.replace(/^(?:\s|\/\*[\s\S]*?\*\/)*/, '');
  if (t.startsWith('#')) return '#';
  const m = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(t);
  return m ? m[0].toUpperCase() : '';
}

const RECORD_NAME = /^(?:\s|\/\*[\s\S]*?\*\/)*#(\d+)(?:\s|\/\*[\s\S]*?\*\/)*=/;

/** Whitespace and comments before a statement: they stay in place, untouched. */
const LEADING_TRIVIA = /^(?:\s|\/\*[\s\S]*?\*\/)*/;
const leadLength = (raw: string) => LEADING_TRIVIA.exec(raw)![0].length;

/**
 * A statement split into code and verbatim parts. Verbatim: `/* *\/` comments
 * and edition-3 resource literals `<...>` (anchor names, URIs such as
 * `<http://x#12>`), both found outside string literals. String literals stay
 * inside the code parts, where `remapEntityText` already leaves them alone.
 */
function segments(text: string): Array<{ text: string; verbatim: boolean }> {
  const parts: Array<{ text: string; verbatim: boolean }> = [];
  let codeStart = 0;
  let i = 0;
  while (i < text.length) {
    if (text[i] === "'") {
      const end = stepStringLiteralEnd(text, i);
      i = end === -1 ? text.length : end;
      continue;
    }
    const comment = text[i] === '/' && text[i + 1] === '*';
    if (comment || text[i] === '<') {
      const end = comment ? text.indexOf('*/', i + 2) : text.indexOf('>', i + 1);
      const stop = end === -1 ? text.length : end + (comment ? 2 : 1);
      if (i > codeStart) parts.push({ text: text.slice(codeStart, i), verbatim: false });
      parts.push({ text: text.slice(i, stop), verbatim: true });
      i = codeStart = stop;
      continue;
    }
    i++;
  }
  if (codeStart < text.length) parts.push({ text: text.slice(codeStart), verbatim: false });
  return parts;
}

/** `#digits` tokens in code: outside string literals, comments and `<...>` literals. */
function referencedIds(text: string, into: Set<number>): void {
  for (const part of segments(text)) {
    if (part.verbatim) continue;
    const code = part.text;
    for (let i = 0; i < code.length; i++) {
      const c = code[i];
      if (c === "'") {
        const end = stepStringLiteralEnd(code, i);
        i = (end === -1 ? code.length : end) - 1;
      } else if (c === '#' && code[i + 1] >= '0' && code[i + 1] <= '9') {
        let j = i + 1;
        while (j < code.length && code[j] >= '0' && code[j] <= '9') j++;
        into.add(Number(code.slice(i + 1, j)));
        i = j - 1;
      }
    }
  }
}

/** `remapEntityText` on the code parts only; comments and `<...>` literals are copied unchanged. */
function remapRecord(text: string, idMap: ReadonlyMap<number, number>): string {
  return segments(text).map(p => (p.verbatim ? p.text : remapEntityText(p.text, 0, idMap))).join('');
}

function shuffleInPlace<T>(items: T[], random: RandomSource): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

/**
 * Renumber every entity instance of a STEP physical file (`#id` -> a seeded
 * permutation of new ids) and rewrite every reference to match.
 *
 * New ids are 1..n, skipping any id that a dangling reference uses, so a
 * dangling reference can never come to point at a real instance.
 */
export function renumberStepIds(text: string, options: RenumberStepIdsOptions): RenumberStepIdsResult {
  const statements = splitStatements(text);
  // DATA records grouped by section (they may be reordered within one), plus the
  // edition-3 ANCHOR and REFERENCE statements, rewritten in place.
  const dataSections: Statement[][] = [];
  const inPlace: Statement[] = [];
  const named: Statement[] = [];
  let section: string | null = null;
  let current: Statement[] | null = null;
  for (const s of statements) {
    const token = leadingToken(text.slice(s.start, s.end));
    if (token === 'DATA') { section = 'DATA'; current = []; dataSections.push(current); continue; }
    if (token === 'ANCHOR' || token === 'REFERENCE') { section = token; current = null; continue; }
    if (token === 'ENDSEC') { section = null; current = null; continue; }
    if (section === 'DATA' && current && token === '#') { current.push(s); named.push(s); }
    else if (section === 'REFERENCE' && token === '#') { inPlace.push(s); named.push(s); }
    else if (section === 'ANCHOR') inPlace.push(s);
  }

  // Instance names come from DATA records and from REFERENCE entries (`#12=<uri>;`).
  const declared = new Map<number, Statement>();
  const referenced = new Set<number>();
  const namedSet = new Set(named);
  for (const r of [...named, ...inPlace.filter(s => !namedSet.has(s))]) {
    const body = text.slice(r.start, r.end);
    const m = namedSet.has(r) ? RECORD_NAME.exec(body) : null;
    if (namedSet.has(r)) {
      if (!m) throw new Error(`renumberStepIds: cannot read the instance name of: ${body.trim().slice(0, 80)}`);
      const id = Number(m[1]);
      if (declared.has(id)) throw new Error(`renumberStepIds: instance #${id} is declared twice`);
      declared.set(id, r);
    }
    referencedIds(m ? body.slice(m[0].length) : body, referenced);
  }

  const danglingReferences = [...referenced].filter(id => !declared.has(id)).sort((a, b) => a - b);
  const blocked = new Set(danglingReferences);
  const pool: number[] = [];
  for (let candidate = 1; pool.length < declared.size; candidate++) {
    if (!blocked.has(candidate)) pool.push(candidate);
  }
  shuffleInPlace(pool, options.random);
  const idMap = new Map<number, number>();
  [...declared.keys()].forEach((id, i) => idMap.set(id, pool[i]));

  // Rewrite each DATA record in its slot. With `reorder`, the records of a
  // section trade slots; the whitespace and comments before each slot stay where
  // they were, unchanged. Comments inside a record body are copied unchanged too.
  const replacement = new Map<Statement, string>();
  const rewrite = (slot: Statement, body: string) => {
    const raw = text.slice(slot.start, slot.end);
    replacement.set(slot, raw.slice(0, leadLength(raw)) + remapRecord(body, idMap));
  };
  const bodyOf = (s: Statement) => { const raw = text.slice(s.start, s.end); return raw.slice(leadLength(raw)); };
  for (const sectionRecords of dataSections) {
    const bodies = sectionRecords.map(bodyOf);
    const order = options.reorder ? shuffleInPlace(bodies.map((_, i) => i), options.random) : bodies.map((_, i) => i);
    sectionRecords.forEach((slot, i) => rewrite(slot, bodies[order[i]]));
  }
  for (const s of inPlace) rewrite(s, bodyOf(s));

  let out = '';
  let last = 0;
  for (const s of [...replacement.keys()].sort((a, b) => a.start - b.start)) {
    out += text.slice(last, s.start) + replacement.get(s);
    last = s.end;
  }
  out += text.slice(last);
  return { text: out, idMap, danglingReferences };
}
