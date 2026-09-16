/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

const STEP_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:E[+-]?\d+)?$/i;
const TYPED_VALUE = /^[A-Z][A-Z0-9_]*\s*\(([\s\S]*)\)$/i;
const STEP_REFERENCE = /^#(0|[1-9]\d*)$/;
const STEP_ZERO = /^[+-]?(?:0+(?:\.0*)?|\.0+)(?:E[+-]?\d+)?$/i;

export function withoutStepComments(token: string): string {
  const scan = new StepTextScan(token);
  const pieces: string[] = [];
  let retainedFrom = 0;
  for (let index = 0; index < token.length;) {
    const skipped = scan.skipLexicalAt(index);
    if (skipped > index) {
      if (token[index] === '/') {
        pieces.push(token.slice(retainedFrom, index), ' ');
        retainedFrom = skipped;
      }
      index = skipped;
      continue;
    }
    index++;
  }
  pieces.push(token.slice(retainedFrom));
  return pieces.join('').trim();
}

const withoutComments = withoutStepComments;

/** Distinguish an omitted STEP attribute from malformed-but-present input. */
export function costAttributePresent(token: string | undefined): boolean {
  if (token === undefined) return false;
  const candidate = withoutComments(token);
  return candidate !== '$' && candidate !== '*';
}

/** Split one entity parameter list while retaining the original STEP lexemes. */
export function splitCostAttributeLexemes(record: string): string[] {
  let open = -1;
  let close = -1;
  let depth = 0;
  const recordScan = new StepTextScan(record);
  for (let index = 0; index < record.length;) {
    const skipped = recordScan.skipLexicalAt(index);
    if (skipped > index) {
      index = skipped;
      continue;
    }
    const char = record[index];
    if (char === '(') {
      if (open < 0) open = index;
      depth++;
    } else if (char === ')' && open >= 0) {
      depth--;
      if (depth === 0) {
        close = index;
        break;
      }
    }
    index++;
  }
  if (open < 0 || close <= open) return [];
  const params = record.slice(open + 1, close);
  const result: string[] = [];
  let start = 0;
  depth = 0;
  const parameterScan = new StepTextScan(params);
  for (let index = 0; index < params.length;) {
    const skipped = parameterScan.skipLexicalAt(index);
    if (skipped > index) {
      index = skipped;
      continue;
    }
    const char = params[index];
    if (char === '(') depth++;
    else if (char === ')') depth--;
    else if (char === ',' && depth === 0) {
      result.push(params.slice(start, index).trim());
      start = index + 1;
    }
    index++;
  }
  result.push(params.slice(start).trim());
  return result;
}

/** Return the exact numeric token, unwrapping an IFC typed value when present. */
export function costNumericLexeme(token: string | undefined): string | undefined {
  if (!token) return undefined;
  let candidate = withoutComments(token);
  const typed = TYPED_VALUE.exec(candidate);
  if (typed) candidate = typed[1].trim();
  return STEP_NUMBER.test(candidate) ? candidate : undefined;
}

/** Return the EXPRESS wrapper around an exact numeric token, if one was supplied. */
export function costNumericTypeLexeme(token: string | undefined): string | undefined {
  if (!token) return undefined;
  const typed = TYPED_VALUE.exec(withoutComments(token));
  return typed ? withoutComments(token).slice(0, withoutComments(token).indexOf('(')).trim().toUpperCase() : undefined;
}

/** True only when the STEP significand is zero; exponent digits do not count. */
export function isZeroCostNumericLexeme(token: string): boolean {
  return STEP_ZERO.test(token);
}

/** Read one exact STEP entity-reference token, rejecting integer literals. */
export function costReferenceLexeme(token: string | undefined): number | undefined {
  if (!token) return undefined;
  const match = STEP_REFERENCE.exec(withoutComments(token));
  return match ? Number(match[1]) : undefined;
}

/** Read a flat non-empty aggregate of exact STEP entity-reference tokens. */
export function costReferenceListLexeme(token: string | undefined): number[] | undefined {
  if (!token) return undefined;
  const candidate = withoutComments(token);
  if (!candidate.startsWith('(') || !candidate.endsWith(')')) return undefined;
  const entries = candidate.slice(1, -1).split(',').map(entry => entry.trim());
  if (entries.length === 0 || entries.some(entry => entry.length === 0)) return undefined;
  const refs = entries.map(entry => costReferenceLexeme(entry));
  return refs.every((ref): ref is number => ref !== undefined) ? refs : undefined;
}
import { StepTextScan } from './step-lexing.js';
