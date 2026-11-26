/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Lossless reader for one STEP (ISO 10303-21) DATA record. Unlike the
 * parser's attribute extractor it keeps every token kind a validator needs:
 * references, INTEGER vs REAL, enumerations, typed values, `$` and `*`.
 */

import { decodeStepStringLiteral } from '@ifc-lite/encoding';
import { BinaryValue, DERIVED, EnumValue, Ref, StepInteger, Typed, UNKNOWN, type Aggregate, type Value } from './values.js';

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

  number(): number | StepInteger {
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
    return real ? n : new StepInteger(n);
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
  return { id, type, attributes: c.list() };
}

/** Split the DATA section of a STEP file into `#id=...;` records, honouring strings and comments. */
export function* splitStepRecords(text: string): Generator<{ id: number; type: string; text: string }> {
  const data = text.search(/\bDATA\s*;/);
  let i = data < 0 ? 0 : text.indexOf(';', data) + 1;
  const endsec = text.indexOf('ENDSEC', i);
  const n = endsec < 0 ? text.length : endsec;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 47 && text.charCodeAt(i + 1) === 42) {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (c !== 35) {
      i++;
      continue;
    }
    let j = i;
    for (; j < n; j++) {
      const ch = text.charCodeAt(j);
      if (ch === 39) {
        j++;
        while (j < n && !(text.charCodeAt(j) === 39 && text.charCodeAt(j + 1) !== 39)) j += text.charCodeAt(j) === 39 ? 2 : 1;
      } else if (ch === 47 && text.charCodeAt(j + 1) === 42) {
        const end = text.indexOf('*/', j + 2);
        j = end < 0 ? n : end + 1;
      } else if (ch === 59) break;
    }
    const record = text.slice(i, j + 1);
    const m = /^#(\d+)\s*=\s*([A-Za-z0-9_]+)/.exec(record);
    if (m) yield { id: Number(m[1]), type: m[2].toUpperCase(), text: record };
    i = j + 1;
  }
}
