/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * STEP reference reading for the empty-container analysis in
 * `merged-empty-containers.ts` (#3643): which `#N` a line names, and where.
 * Split out of that module when #5725 grew it past the module-size limit.
 *
 * Every reader here tolerates STEP trivia (whitespace and/or a `/* ... *​/`
 * comment, #3789) between tokens; a line whose arguments cannot be read comes
 * back `null`, which the analysis treats as "can't safely rewrite" and so blocks
 * the drop, never as "names nothing".
 */

import { readStepSlots, splitTopLevelListItems } from './step-argument-parser.js';
import { BARE_REF_RE } from './reference-collector.js';

/** Top-level arguments of a `#id=TYPE(…);` line, or `null` when unparseable. */
export function topLevelAttrs(line: string): string[] | null {
  const record = readStepSlots(line);
  return record === null ? null : record.slots.map(arg => arg.trim());
}

/** `"#7"` → `7` via shared, trivia-tolerant {@link BARE_REF_RE} (#4227 — a narrower regex misclassified a comment-wrapped `RelatingObject`). */
export function singleRef(arg: string): number | null {
  const match = BARE_REF_RE.exec(arg);
  return match ? Number(match[1]) : null;
}

/** Parse a `(#a,#b,…)` list argument into ids. */
export function refList(arg: string): number[] {
  const trimmed = arg.trim();
  if (!trimmed.startsWith('(') || !trimmed.endsWith(')')) return [];
  const inner = trimmed.slice(1, -1).trim();
  if (inner === '') return [];
  const ids: number[] = [];
  for (const item of splitTopLevelListItems(inner)) {
    const id = singleRef(item);
    if (id !== null) ids.push(id);
  }
  return ids;
}

/**
 * Every reference in a line's argument list, paired with whether it sits
 * somewhere neither `filterHiddenRefsFromRelationshipLine` can strip (a direct
 * list element) nor withhold the line for (a whole single-valued attribute) —
 * i.e. nested inside a list of lists or a typed value. `null` when the line's
 * argument list cannot be parsed at all: a line no rewrite can narrow, which the
 * analysis must treat as a blocker rather than as "names nothing".
 */
export function classifyRefs(line: string): Array<[number, boolean]> | null {
  const attrs = topLevelAttrs(line);
  if (attrs === null) return null;
  const out: Array<[number, boolean]> = [];
  for (const attr of attrs) {
    const direct = singleRef(attr);
    if (direct !== null) {
      out.push([direct, false]);
      continue;
    }
    if (attr.startsWith('(') && attr.endsWith(')')) {
      const inner = attr.slice(1, -1).trim();
      if (inner === '') continue;
      for (const item of splitTopLevelListItems(inner)) {
        const id = singleRef(item);
        if (id !== null) out.push([id, false]);
        else for (const nested of argRefs(item)) out.push([nested, true]);
      }
      continue;
    }
    for (const nested of argRefs(attr)) out.push([nested, true]);
  }
  return out;
}

/**
 * Every `#N` reference in a chunk of STEP text, skipping quoted strings (where a
 * `#` is literal) and any leading `#id=` (the line's own id). Reads bytes rather
 * than decoded text so the reverse-reference scan never decodes a whole model.
 */
export function argRefs(text: Uint8Array | string): number[] {
  const bytes = typeof text === 'string' ? new TextEncoder().encode(text) : text;
  const eq = bytes.indexOf(0x3d /* = */);
  const from = eq === -1 ? 0 : eq + 1;
  const out: number[] = [];
  let inString = false;
  for (let i = from; i < bytes.length; i++) {
    const byte = bytes[i];
    if (byte === 0x27 /* ' */) {
      inString = !inString;
      continue;
    }
    if (inString || byte !== 0x23 /* # */) continue;
    let j = i + 1;
    let value = 0;
    while (j < bytes.length && bytes[j] >= 0x30 && bytes[j] <= 0x39) {
      value = value * 10 + (bytes[j] - 0x30);
      j++;
    }
    if (j > i + 1) {
      out.push(value);
      i = j - 1;
    }
  }
  return out;
}

/** The GlobalId (first quoted attribute) of a rooted entity's line. */
export function leadingGuid(line: string): string | null {
  const open = line.indexOf('(');
  if (open === -1) return null;
  const first = line.indexOf("'", open + 1);
  if (first === -1) return null;
  const second = line.indexOf("'", first + 1);
  if (second === -1) return null;
  const raw = line.slice(first + 1, second);
  return /^[0-9A-Za-z_$]{22}$/.test(raw) ? raw : null;
}
