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
 * which also honours the `\S\'` PAGE operand) and outside comments. The HEADER
 * section and every non-record statement are copied verbatim.
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

/** `#digits` tokens outside string literals. */
function referencedIds(text: string, into: Set<number>): void {
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'") {
      const end = stepStringLiteralEnd(text, i);
      i = (end === -1 ? text.length : end) - 1;
    } else if (c === '#' && text[i + 1] >= '0' && text[i + 1] <= '9') {
      let j = i + 1;
      while (j < text.length && text[j] >= '0' && text[j] <= '9') j++;
      into.add(Number(text.slice(i + 1, j)));
      i = j - 1;
    }
  }
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
  // Record statements, grouped by the DATA section they sit in.
  const sections: Statement[][] = [];
  let current: Statement[] | null = null;
  for (const s of statements) {
    const token = leadingToken(text.slice(s.start, s.end));
    if (token === 'DATA') { current = []; sections.push(current); continue; }
    if (token === 'ENDSEC') { current = null; continue; }
    if (current && token === '#') current.push(s);
  }

  const records = sections.flat();
  const declared = new Map<number, Statement>();
  const referenced = new Set<number>();
  for (const r of records) {
    const body = text.slice(r.start, r.end);
    const m = RECORD_NAME.exec(body);
    if (!m) throw new Error(`renumberStepIds: cannot read the instance name of: ${body.trim().slice(0, 80)}`);
    const id = Number(m[1]);
    if (declared.has(id)) throw new Error(`renumberStepIds: instance #${id} is declared twice`);
    declared.set(id, r);
    referencedIds(body.slice(m[0].length), referenced);
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

  // Rewrite each record in its slot. With `reorder`, the records of a section
  // trade slots; the whitespace and comments before each slot stay where they
  // were, unchanged. A comment INSIDE a record body is rewritten like the body.
  const replacement = new Map<Statement, string>();
  for (const section of sections) {
    const bodies = section.map(s => {
      const raw = text.slice(s.start, s.end);
      return raw.slice(leadLength(raw));
    });
    const order = options.reorder ? shuffleInPlace(bodies.map((_, i) => i), options.random) : bodies.map((_, i) => i);
    section.forEach((slot, i) => {
      const raw = text.slice(slot.start, slot.end);
      const lead = raw.slice(0, leadLength(raw));
      replacement.set(slot, lead + remapEntityText(bodies[order[i]], 0, idMap));
    });
  }

  let out = '';
  let last = 0;
  for (const s of records) {
    out += text.slice(last, s.start) + replacement.get(s);
    last = s.end;
  }
  out += text.slice(last);
  return { text: out, idMap, danglingReferences };
}
