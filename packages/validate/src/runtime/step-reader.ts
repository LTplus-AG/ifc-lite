/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Lossless reader for one STEP (ISO 10303-21) DATA record. Unlike the
 * parser's attribute extractor it keeps every token kind a validator needs:
 * references, INTEGER vs REAL, enumerations, typed values, `$` and `*`.
 */

import { decodeStepStringLiteral } from '@ifc-lite/encoding';
import { BinaryValue, DERIVED, EnumValue, Ref, StepInteger, StepReal, Typed, UNKNOWN, type Aggregate, type Value } from './values.js';

export class StepRecordError extends Error {
  constructor(message: string, readonly offset: number) {
    super(message);
    this.name = 'StepRecordError';
  }
}

export interface StepRecord {
  id: number;
  type: string;
  attributes: Value[];
}

export type TypeNameResolver = (upper: string) => string;

const isDigit = (c: number) => c >= 48 && c <= 57;
const isWord = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || isDigit(c) || c === 95;

class Cursor {
  i = 0;
  constructor(readonly s: string, readonly resolve: TypeNameResolver) {}

  skip(): void {
    const s = this.s;
    for (;;) {
      const c = s.charCodeAt(this.i);
      if (c <= 32 && this.i < s.length) { this.i++; continue; }
      if (c === 47 && s.charCodeAt(this.i + 1) === 42) {
        const end = s.indexOf('*/', this.i + 2);
        this.i = end < 0 ? s.length : end + 2;
        continue;
      }
      return;
    }
  }

  fail(message: string): never {
    throw new StepRecordError(message, this.i);
  }

  word(): string {
    const start = this.i;
    while (this.i < this.s.length && isWord(this.s.charCodeAt(this.i))) this.i++;
    if (this.i === start) this.fail('expected keyword');
    return this.s.slice(start, this.i);
  }

  list(): Aggregate {
    this.i++;
    const out: Aggregate = [];
    this.skip();
    if (this.s.charCodeAt(this.i) === 41) { this.i++; return out; }
    for (;;) {
      out.push(this.value());
      this.skip();
      const c = this.s.charCodeAt(this.i);
      this.i++;
      if (c === 41) return out;
      if (c !== 44) this.fail("expected ',' or ')'");
    }
  }

  string(): string {
    const s = this.s;
    let j = this.i + 1;
    for (;;) {
      const k = s.indexOf("'", j);
      if (k < 0) this.fail('unterminated string');
      if (s.charCodeAt(k + 1) === 39) { j = k + 2; continue; }
      const inner = s.slice(this.i + 1, k);
      this.i = k + 1;
      return inner.includes('\\') || inner.includes("''") ? decodeStepStringLiteral(inner) : inner;
    }
  }

  number(): number | StepInteger | StepReal {
    const s = this.s;
    const start = this.i;
    if (s[this.i] === '-' || s[this.i] === '+') this.i++;
    while (isDigit(s.charCodeAt(this.i))) this.i++;
    let real = false;
    if (s[this.i] === '.') {
      real = true;
      this.i++;
      while (isDigit(s.charCodeAt(this.i))) this.i++;
    }
    if (s[this.i] === 'E' || s[this.i] === 'e') {
      real = true;
      this.i++;
      if (s[this.i] === '-' || s[this.i] === '+') this.i++;
      while (isDigit(s.charCodeAt(this.i))) this.i++;
    }
    const text = s.slice(start, this.i);
    const n = Number(text);
    if (!Number.isFinite(n) || text === '-' || text === '+') this.fail(`invalid number '${text}'`);
    if (!real) return new StepInteger(n);
    return Number.isInteger(n) ? new StepReal(n) : n;
  }

  value(): Value {
    this.skip();
    const s = this.s;
    const c = s.charCodeAt(this.i);
    if (c === 36) { this.i++; return undefined; }
    if (c === 42) { this.i++; return DERIVED; }
    if (c === 35) {
      this.i++;
      const start = this.i;
      while (isDigit(s.charCodeAt(this.i))) this.i++;
      if (start === this.i) this.fail('expected reference id');
      return new Ref(Number(s.slice(start, this.i)));
    }
    if (c === 39) return this.string();
    if (c === 34) {
      const end = s.indexOf('"', this.i + 1);
      if (end < 0) this.fail('unterminated binary');
      const hex = s.slice(this.i + 1, end);
      this.i = end + 1;
      return new BinaryValue(hex);
    }
    if (c === 40) return this.list();
    if (c === 46) {
      const end = s.indexOf('.', this.i + 1);
      if (end < 0) this.fail('unterminated enumeration');
      const name = s.slice(this.i + 1, end).toUpperCase();
      this.i = end + 1;
      if (name === 'T') return true;
      if (name === 'F') return false;
      if (name === 'U') return UNKNOWN;
      return new EnumValue(name);
    }
    if (isDigit(c) || c === 45 || c === 43) return this.number();
    const keyword = this.word();
    this.skip();
    if (s.charCodeAt(this.i) !== 40) this.fail(`expected '(' after ${keyword}`);
    this.i++;
    const inner = this.value();
    this.skip();
    if (s.charCodeAt(this.i) !== 41) this.fail(`expected ')' closing ${keyword}`);
    this.i++;
    return new Typed(this.resolve(keyword.toUpperCase()), inner);
  }
}

const identity: TypeNameResolver = (upper) => upper;

/** Decode `#id=TYPE(attr,...);` (the trailing `;` is optional). */
export function readStepRecord(text: string, resolve: TypeNameResolver = identity): StepRecord {
  const c = new Cursor(text, resolve);
  c.skip();
  if (text.charCodeAt(c.i) !== 35) c.fail("expected '#'");
  c.i++;
  const id = Number(c.word());
  c.skip();
  if (text.charCodeAt(c.i) !== 61) c.fail("expected '='");
  c.i++;
  c.skip();
  const type = c.word().toUpperCase();
  c.skip();
  if (text.charCodeAt(c.i) !== 40) c.fail("expected '('");
  const attributes = c.list();
  c.skip();
  if (text[c.i] === ';') { c.i++; c.skip(); }
  if (c.i !== text.length) c.fail('unexpected trailing tokens after record attributes');
  return { id, type, attributes };
}

/** STEP statements end at a semicolon outside a string, binary literal or comment. */
function* statements(text: string): Generator<string> {
  const cursor = new Cursor(text, identity);
  while (cursor.i < text.length) {
    cursor.skip();
    const start = cursor.i;
    let quote = '';
    while (cursor.i < text.length) {
      const ch = text[cursor.i++];
      if (quote) {
        if (ch !== quote) continue;
        if (quote === "'" && text[cursor.i] === "'") cursor.i++;
        else quote = '';
      } else if (ch === "'" || ch === '"') quote = ch;
      else if (ch === '/' && text[cursor.i] === '*') {
        const end = text.indexOf('*/', cursor.i + 1);
        cursor.i = end < 0 ? text.length : end + 2;
      } else if (ch === ';') break;
    }
    if (cursor.i > start) yield text.slice(start, cursor.i);
  }
}

/** A complete section delimiter outside quoted values and comments ends the header prefix. */
export function headerBoundaryReached(text: string): boolean {
  for (const statement of statements(text)) {
    if (/^(?:ENDSEC|DATA)\b/i.test(statement) && statement.endsWith(';')) return true;
  }
  return false;
}

export function* sectionRecords(text: string, section: 'HEADER' | 'DATA'): Generator<string> {
  let active = false;
  let bare = section === 'DATA';
  for (const statement of statements(text)) {
    if (bare && statement.startsWith('#')) { yield statement; continue; }
    bare = false;
    if (statement.startsWith('#')) {
      if (active) yield statement;
      continue;
    }
    const keyword = /^[A-Z0-9_-]+/i.exec(statement)?.[0].toUpperCase();
    if (keyword === 'ENDSEC' && active) return;
    if (keyword === section) active = true;
    else if (active) yield statement;
  }
}

export function headerRecords(text: string): Map<string, Value[]> {
  const records = new Map<string, Value[]>();
  for (const statement of sectionRecords(text, 'HEADER')) {
    try {
      const record = readStepRecord(`#0=${statement}`);
      records.set(record.type, record.attributes);
    } catch (error) {
      if (!(error instanceof StepRecordError)) throw error;
      // The header validator reports absent or unreadable attributes.
    }
  }
  return records;
}

export function* splitStepRecords(text: string, onMalformed?: (message: string) => void): Generator<{ id: number; type: string; text: string }> {
  for (const record of sectionRecords(text, 'DATA')) {
    const m = /^#(\d+)\s*=\s*([A-Za-z0-9_]+)/.exec(record);
    if (m) {
      yield { id: Number(m[1]), type: m[2].toUpperCase(), text: record };
      continue;
    }
    // The fast path also misses legal comments between the instance id and its type.
    try {
      const parsed = readStepRecord(record);
      yield { id: parsed.id, type: parsed.type, text: record };
    } catch (error) {
      if (!(error instanceof StepRecordError)) throw error;
      const id = /^#(\d+)/.exec(record);
      if (id) yield { id: Number(id[1]), type: '', text: record };
      else onMalformed?.(error.message);
    }
  }
}
