/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `mutate.ts`'s STEP-text rewrite path: finding an entity record's exact
 * bytes in the exported output and splicing a new attribute value into it.
 *
 * Split out of `mutate.ts` (a sibling, not a growth of that file) to stay
 * under the repo's module-size budget.
 *
 * Record LOCATION on main is a per-line regex plus `indexOf('(')` /
 * `lastIndexOf(')')`. That silently drops a mutation -- reporting success
 * with an unwritten edit -- on a record wrapped across several lines, or on
 * one with a comment between its class keyword and `(`
 * (LTplus-AG/ifc-lite#4163): the regex simply does not match, the line is
 * `continue`d past, and nothing marks the mutation as failed.
 *
 * This module locates the record with `StepTokenizer.scanEntities()`
 * (`@ifc-lite/parser`) -- the same balanced-parenthesis, string- and
 * comment-aware scan the parser itself indexes entities with -- to get each
 * target record's exact byte span, wherever it falls relative to line
 * breaks. A record the scan cannot find is now a NAMED failure instead of a
 * silent no-op.
 *
 * The argument list inside that span is split with `splitTopLevelStepArgs`
 * from `./step-args.js` -- the SAME validating splitter `mutate.ts` uses on
 * main: every part must be exactly one STEP token, checked at every depth,
 * or the split is refused (LTplus-AG/ifc-lite#4125 / #2470 -- an undoubled
 * apostrophe inside a string swallows top-level commas, and a by-index
 * write on a mis-scanned split lands on the wrong attribute while reporting
 * success). An earlier version of this module carried its own
 * non-validating splitter and reintroduced exactly that corruption; it is
 * gone.
 *
 * `scanEntities()`'s own balanced-paren scan can itself be fooled: a stray,
 * unmatched `)` inside a malformed record's argument list brings the depth
 * back to 0 early, so the scan reports a record that ends there -- silently
 * TRUNCATED, well short of the record's real (malformed) extent, with the
 * rest of the same record's bytes left looking like orphaned text after it.
 * The truncated span is internally well-formed (it is exactly as long as it
 * is balanced), so a validating splitter given only that span cannot see
 * the truncation either. The guard is structural, not lexical: a located
 * record's closing `)` must be followed (modulo STEP trivia) by `;`, the
 * record terminator. A genuine record always has one there; a truncated one
 * does not, because the bytes that would carry it are still unconsumed
 * argument text.
 */

import { StepTokenizer } from '@ifc-lite/parser';
import { splitTopLevelStepArgs } from './step-args.js';

/**
 * IFC entity attribute indices (0-based positions in STEP argument list).
 * Standard for all IfcRoot subtypes: GlobalId(0), OwnerHistory(1), Name(2), Description(3).
 * IfcObject subtypes add ObjectType(4). Tag varies by entity type.
 */
export const ATTRIBUTE_INDEX: Record<string, number> = {
  name: 2,
  description: 3,
  objecttype: 4,
};

/**
 * ISO 10303-21 trivia: whitespace or a `/* ... *\/` comment, either one
 * repeated any number of times. A comment is legal wherever whitespace is,
 * including between a record's class keyword and its `(` -- the gap the
 * line regex on main cannot see past (#4163) -- and between a record's
 * closing `)` and its terminating `;`, which is what the truncation guard
 * below has to skip past.
 */
const TRIVIA_RE = /^(?:[ \t\r\n\f\v]|\/\*[\s\S]*?\*\/)*/;

function skipTrivia(text: string, i: number): number {
  const m = TRIVIA_RE.exec(text.slice(i));
  return i + (m ? m[0].length : 0);
}

/**
 * Walk `recordText` (exactly `#<id><trivia>=<trivia><TYPE><trivia>(...)`, the
 * span `StepTokenizer.scanEntities()` yields) to find where the argument
 * list opens.
 *
 * Composed from the same trivia rule the byte-level scan uses rather than a
 * single `indexOf('(')`, so a comment between the id, the `=` and the class
 * keyword cannot be mistaken for the record's own text -- and a `(` written
 * INSIDE such a comment cannot be mistaken for the argument list's open
 * paren (#4163's first symptom).
 *
 * Returns the index of the record's own `(`, or -1 if `recordText` is not
 * shaped the way the scan promises.
 */
function findArgsOpen(recordText: string): number {
  if (recordText[0] !== '#') return -1;
  let i = 1;
  const idStart = i;
  while (i < recordText.length && recordText[i] >= '0' && recordText[i] <= '9') i++;
  if (i === idStart) return -1;

  i = skipTrivia(recordText, i);
  if (recordText[i] !== '=') return -1;
  i++;

  i = skipTrivia(recordText, i);
  const typeStart = i;
  while (i < recordText.length && /[A-Za-z0-9_]/.test(recordText[i])) i++;
  if (i === typeStart) return -1;

  i = skipTrivia(recordText, i);
  return recordText[i] === '(' ? i : -1;
}

/** One target record, once its span (and terminator) has been confirmed good. */
interface ReadableRecord {
  expressId: number;
  type: string;
  argsStart: number; // index of the char right after the record's own '(', within recordText
  recordText: string; // "#id=TYPE(...)" without the trailing ';'
  offset: number; // byte offset of recordText within the original content
  length: number; // byte length of recordText
}

/**
 * Apply attribute mutations to STEP content via text replacement.
 *
 * For each target entity, locates the record's exact bytes with
 * `StepTokenizer.scanEntities()` (multi-line records, and records with a
 * comment before their `(`, included) and rewrites the attribute at its
 * known slot index using the validating splitter (`splitTopLevelStepArgs`,
 * `./step-args.js`) -- the same one `mutate.ts` uses on main, so a
 * mis-scanned argument list is refused here exactly as it would be there
 * (#4125).
 *
 * Every record this call was asked to mutate is read and validated FIRST;
 * only if every one of them is readable does any rewriting happen, and the
 * function returns the fully rewritten content. If ANY of them cannot be
 * located, its span isn't followed by the STEP record terminator `;`
 * (the truncation guard -- see the module header), or its argument list
 * cannot be split unambiguously, nothing is rewritten and one error names
 * every record that failed. The alternative -- writing the records that
 * were fine and skipping the rest -- is a run that reports success over a
 * file that carries only part of the requested edit.
 */
export function applyAttributeMutations(
  content: string,
  mutations: { entity: any; propName: string; value: string }[],
  objectTypeEntities: ReadonlySet<string>,
): string {
  const mutationsByEntity = new Map<number, { propName: string; value: string }[]>();
  for (const m of mutations) {
    const id = m.entity.ref.expressId;
    const list = mutationsByEntity.get(id) ?? [];
    list.push({ propName: m.propName, value: m.value });
    mutationsByEntity.set(id, list);
  }
  if (mutationsByEntity.size === 0) return content;

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const bytes = encoder.encode(content);

  const located = new Map<number, { offset: number; length: number; type: string }>();
  for (const rec of new StepTokenizer(bytes).scanEntities()) {
    if (mutationsByEntity.has(rec.expressId) && !located.has(rec.expressId)) {
      located.set(rec.expressId, { offset: rec.offset, length: rec.length, type: rec.type.toUpperCase() });
    }
  }

  // Every entity is located, guarded and split in ORIGINAL request order, so
  // a run naming several unreadable records lists them in the order they
  // were asked for, not the order the failure happened to be detected in.
  const unreadable: string[] = [];
  const readable: ReadableRecord[] = [];

  for (const [expressId] of mutationsByEntity) {
    const rec = located.get(expressId);
    if (!rec) {
      unreadable.push(`#${expressId}`);
      continue;
    }

    // Truncation guard: a genuine record's closing ')' is followed (modulo
    // trivia) by ';'. If it is not, `scanEntities()`'s balanced-paren scan
    // closed this span early -- typically a stray, unmatched ')' inside a
    // malformed argument list -- and the span is shorter than the record
    // actually is.
    const tailStart = rec.offset + rec.length;
    const tail = decoder.decode(bytes.subarray(tailStart, Math.min(tailStart + 256, bytes.length)));
    const afterTrivia = skipTrivia(tail, 0);
    if (tail[afterTrivia] !== ';') {
      unreadable.push(`#${expressId}=${rec.type}`);
      continue;
    }

    const recordText = decoder.decode(bytes.subarray(rec.offset, rec.offset + rec.length));
    const argsOpen = findArgsOpen(recordText);
    if (argsOpen === -1 || recordText[recordText.length - 1] !== ')') {
      unreadable.push(`#${expressId}=${rec.type}`);
      continue;
    }

    const argsText = recordText.slice(argsOpen + 1, recordText.length - 1);
    const args = splitTopLevelStepArgs(argsText);
    if (args === null) {
      unreadable.push(`#${expressId}=${rec.type}`);
      continue;
    }

    readable.push({
      expressId,
      type: rec.type,
      argsStart: argsOpen + 1,
      recordText,
      offset: rec.offset,
      length: rec.length,
    });
  }

  const rewrites = new Map<number, string>();
  for (const rec of readable) {
    const argsText = rec.recordText.slice(rec.argsStart, rec.recordText.length - 1);
    // Re-split rather than threading the result through: cheap (records are
    // short), and keeps this loop free of anything that can itself fail --
    // every possible failure was already surfaced, in order, above.
    const args = splitTopLevelStepArgs(argsText)!;

    const entityMuts = mutationsByEntity.get(rec.expressId)!;
    for (const mut of entityMuts) {
      const attrIdx = ATTRIBUTE_INDEX[mut.propName.toLowerCase()];
      if (attrIdx !== undefined && attrIdx < args.length) {
        if (mut.propName.toLowerCase() === 'objecttype' && !objectTypeEntities.has(rec.type)) {
          process.stderr.write(`Warning: attribute "ObjectType" not applicable to ${rec.type} #${rec.expressId}, skipping\n`);
          continue;
        }
        const escaped = mut.value.replace(/\\/g, '\\\\').replace(/'/g, "''");
        args[attrIdx] = `'${escaped}'`;
      } else {
        process.stderr.write(`Warning: attribute "${mut.propName}" not recognized for entity #${rec.expressId}\n`);
      }
    }

    const prefix = rec.recordText.slice(0, rec.argsStart);
    rewrites.set(rec.expressId, prefix + args.join(',') + ')');
  }

  if (unreadable.length > 0) {
    throw new Error(
      `refusing to rewrite ${unreadable.length} record(s) whose STEP text could not be read as a ` +
        `complete argument list: ${unreadable.join(', ')}. Attributes are written by index, so a ` +
        `mis-scanned list would put the value on the wrong attribute and drop the ones it swallowed ` +
        `(LTplus-AG/ifc-lite#4125). Usual causes: an undoubled apostrophe inside a quoted string, an ` +
        `unbalanced parenthesis, a comment inside the argument list, or a record this scan could not ` +
        `locate at all. No output file was written.`,
    );
  }

  // Rewrite from the highest byte offset down, so a length change from an
  // earlier (in file order) edit cannot invalidate an offset recorded for a
  // record not yet processed.
  let outBytes = bytes;
  const ordered = readable
    .filter((r) => rewrites.has(r.expressId) && rewrites.get(r.expressId) !== r.recordText)
    .sort((a, b) => b.offset - a.offset);
  for (const rec of ordered) {
    const rewritten = rewrites.get(rec.expressId)!;
    const rewrittenBytes = encoder.encode(rewritten);
    const tailStart = rec.offset + rec.length;
    const merged = new Uint8Array(rec.offset + rewrittenBytes.length + (outBytes.length - tailStart));
    merged.set(outBytes.subarray(0, rec.offset), 0);
    merged.set(rewrittenBytes, rec.offset);
    merged.set(outBytes.subarray(tailStart), rec.offset + rewrittenBytes.length);
    outBytes = merged;
  }

  return decoder.decode(outBytes);
}
