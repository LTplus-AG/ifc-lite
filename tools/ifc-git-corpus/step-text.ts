/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createHash } from 'node:crypto';
import { isValidIfcGuid } from '@ifc-lite/encoding';

const STEP_LINE_RE = /^#(\d+)=([A-Z0-9_]+)\((.*)\);\s*$/;
/** The 64-character IFC GUID alphabet, 22 characters wide. */
const IFC_GUID_RE = /^[0-9A-Za-z_$]{22}$/;

export interface StepLine {
  readonly index: number;
  readonly id: number;
  readonly type: string;
  readonly args: string;
}

export function indexLines(lines: readonly string[]): Map<number, StepLine> {
  const out = new Map<number, StepLine>();
  lines.forEach((line, index) => {
    const m = STEP_LINE_RE.exec(line);
    if (m) out.set(Number(m[1]), { index, id: Number(m[1]), type: m[2], args: m[3] });
  });
  return out;
}

/** Split top-level STEP arguments, respecting quotes and nesting. */
export function splitArgs(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if (quoted) {
      if (ch === "'") quoted = args[i + 1] === "'" ? (i++, true) : false;
      continue;
    }
    if (ch === "'") quoted = true;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(args.slice(start, i));
      start = i + 1;
    }
  }
  out.push(args.slice(start));
  return out;
}

export function findByType(index: Map<number, StepLine>, type: string): StepLine[] {
  return [...index.values()].filter((l) => l.type === type).sort((a, b) => a.id - b.id);
}

export function requireOne(lines: StepLine[], what: string): StepLine {
  if (lines.length === 0) throw new Error(`base model has no ${what}`);
  return lines[0];
}

/** Replace one whole record, keeping its position. */
export function rewriteRecord(lines: string[], line: StepLine, args: readonly string[]): void {
  lines[line.index] = `#${line.id}=${line.type}(${args.join(',')});`;
}

export function globalIdOf(line: StepLine): string | null {
  const first = splitArgs(line.args)[0] ?? '';
  const m = /^'(.*)'$/.exec(first);
  if (!m) return null;
  return IFC_GUID_RE.test(m[1]) && isValidIfcGuid(m[1]) ? m[1] : null;
}

/** Every record whose arg[0] is a GlobalId — i.e. every `IfcRoot`. */
export function rootedLines(index: Map<number, StepLine>): StepLine[] {
  return [...index.values()].filter((l) => globalIdOf(l) !== null).sort((a, b) => a.id - b.id);
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * How many OTHER records reference `#id`. The record's own declaration is not a
 * reference, so it is discounted.
 */
export function referenceCount(lines: readonly string[], target: StepLine): number {
  const re = new RegExp(`#${target.id}(?![0-9])`, 'g');
  let count = 0;
  lines.forEach((line, i) => {
    const hits = line.match(re)?.length ?? 0;
    count += i === target.index ? hits - 1 : hits;
  });
  return count;
}

/**
 * STEP serialisation of a REAL. `IfcLengthMeasure` is a REAL, and ISO 10303-21
 * requires the decimal point even on an integral value: `250` is an INTEGER
 * literal and not schema-valid where a REAL is expected.
 */
export function stepReal(value: number): string {
  const text = String(value);
  return /[.eE]/.test(text) ? text : `${text}.`;
}

