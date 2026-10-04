/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `stripScheduleEntities` and the STEP statement tokenizer it walks with —
 * the "remove every 4D record from this STEP text" half of
 * `export-adapter.ts`'s schedule rewrite path, split into its own module so
 * that file stays under its recorded module-size budget (see
 * `scripts/module-size-allowlist.txt`). Pure string in / string out: it
 * never touches the store, the viewer, or the DOM.
 */

/**
 * Remove every schedule-related entity declaration from the STEP body.
 *
 * Two-pass:
 *   1. Identify every express ID whose entity type is in the "always a
 *      schedule entity" set (`IfcTask`, `IfcWorkSchedule`, `IfcWorkPlan`,
 *      `IfcTaskTime`, `IfcLagTime`, `IfcWorkCalendar` + its own entities).
 *   2. Drop lines whose ID is in that set OR whose entity type is one of
 *      the sometimes-schedule types (`IfcRelSequence`, `IfcRelAssignsTo-
 *      Process`, `IfcRelAssignsToControl`) and references any ID from
 *      step 1. `IfcRelNests` and `IfcRelAssignsToProduct` are pruned
 *      instead: schedule ids leave their RelatedObjects, and the record is
 *      dropped only when nothing else remains.
 *
 * The pruning keeps cost-item/resource nests and cost items pricing a
 * product, which share those entities but aren't schedule-owned. The
 * serializer re-emits the task side of IfcRelAssignsToProduct (task
 * outputs, #6749), so leaving it would point at a deleted IfcTask.
 */
const ALWAYS_SCHEDULE_TYPES: ReadonlySet<string> = new Set([
  'IFCTASK',
  'IFCWORKSCHEDULE',
  'IFCWORKPLAN',
  'IFCTASKTIME',
  'IFCTASKTIMERECURRING',
  'IFCLAGTIME',
  // #4830. Each of the three below is reachable ONLY from the 4D pipeline —
  // IfcWorkTime from a calendar's WorkingTimes/ExceptionTimes,
  // IfcRecurrencePattern from an IfcWorkTime or IfcTaskTimeRecurring,
  // IfcTimePeriod from a pattern's TimePeriods — so all are schedule-owned.
  // Leaving them while the serializer re-emits the calendar would duplicate
  // the whole calendar on every edited export.
  'IFCWORKCALENDAR',
  'IFCWORKTIME',
  'IFCRECURRENCEPATTERN',
  'IFCTIMEPERIOD',
]);

const SOMETIMES_SCHEDULE_TYPES: ReadonlySet<string> = new Set([
  'IFCRELSEQUENCE',
  'IFCRELASSIGNSTOPROCESS',
  'IFCRELASSIGNSTOCONTROL',
]);

export function stripScheduleEntities(stepContent: string): string {
  // Pass 1: collect schedule-entity IDs by tokenizing declarations.
  //
  // We walk the STEP content at the STATEMENT level (terminated by `;`
  // outside string literals), not line-by-line. Line-based splitting
  // breaks when a writer spans an entity across multiple lines —
  // valid STEP allows whitespace and newlines anywhere outside string
  // literals. Statement-based walking handles multi-line entities
  // transparently.
  const statements = tokenizeStepStatements(stepContent);
  const scheduleIds = new Set<number>();
  for (const stmt of statements) {
    if (stmt.kind !== 'entity') continue;
    if (ALWAYS_SCHEDULE_TYPES.has(stmt.typeUpper)) scheduleIds.add(stmt.id);
  }

  if (scheduleIds.size === 0) {
    // No "always" schedule entities. There can't be any schedule-related
    // relationship entities either; nothing to strip.
    return stepContent;
  }

  // Pass 2: collect statement edits. Most schedule records are deleted;
  // mixed IfcRelNests records are rewritten so non-schedule children remain.
  const edits: Array<{ start: number; end: number; replacement: string }> = [];
  let cursor = 0;
  for (const stmt of statements) {
    if (stmt.kind !== 'entity') {
      // Non-entity text (header, section markers, whitespace) — always keep.
      continue;
    }
    const action = classifyScheduleStatement(stmt, scheduleIds);
    if (action === 'drop') {
      let end = stmt.end;
      // Also consume a trailing newline so we don't leave blank lines
      // scattered where schedule statements used to live.
      if (stepContent[end] === '\r') end++;
      if (stepContent[end] === '\n') end++;
      edits.push({ start: stmt.start, end, replacement: '' });
    } else if (action !== 'keep') {
      const original = stepContent.slice(stmt.start, stmt.end);
      edits.push({
        start: stmt.start,
        end: stmt.end,
        replacement: original.replace(stmt.attributesText, action.attributesText),
      });
    }
  }

  if (edits.length === 0) return stepContent;
  let out = '';
  for (const edit of edits) {
    out += stepContent.slice(cursor, edit.start);
    out += edit.replacement;
    cursor = edit.end;
  }
  out += stepContent.slice(cursor);
  return out;
}

type StripAction = 'keep' | 'drop' | { attributesText: string };

/** Per-statement classification: keep, drop, or rewrite this record. */
function classifyScheduleStatement(
  stmt: { typeUpper: string; id: number; attributesText: string },
  scheduleIds: ReadonlySet<number>,
): StripAction {
  if (scheduleIds.has(stmt.id)) return 'drop'; // Always-schedule entity itself.
  if (SOMETIMES_SCHEDULE_TYPES.has(stmt.typeUpper)) {
    // Relationship entity; strip only if it references a schedule id.
    return referencesAnyId(stmt.attributesText, scheduleIds) ? 'drop' : 'keep';
  }
  const layout = PRUNED_RELATION_LAYOUTS.get(stmt.typeUpper);
  if (layout) return classifyPrunedRelation(stmt.attributesText, scheduleIds, layout);
  return 'keep';
}

/** Attribute positions of a relation whose RelatedObjects may mix schedule and non-schedule ids. */
interface PrunedRelationLayout {
  arity: number;
  relating: number;
  related: number;
}

const PRUNED_RELATION_LAYOUTS: ReadonlyMap<string, PrunedRelationLayout> = new Map([
  // IfcRelNests: GlobalId, OwnerHistory, Name, Description,
  // RelatingObject, RelatedObjects.
  ['IFCRELNESTS', { arity: 6, relating: 4, related: 5 }],
  // IfcRelAssignsToProduct: GlobalId, OwnerHistory, Name, Description,
  // RelatedObjects, RelatedObjectsType, RelatingProduct.
  ['IFCRELASSIGNSTOPRODUCT', { arity: 7, relating: 6, related: 4 }],
]);

function classifyPrunedRelation(
  attributesText: string,
  scheduleIds: ReadonlySet<number>,
  layout: PrunedRelationLayout,
): StripAction {
  const attributes = splitTopLevelAttributes(attributesText);
  if (attributes.length !== layout.arity) {
    return referencesAnyId(attributesText, scheduleIds) ? 'drop' : 'keep';
  }
  const relatingId = parseStepRef(attributes[layout.relating]);
  if (relatingId !== undefined && scheduleIds.has(relatingId)) return 'drop';

  const related = splitReferenceAggregate(attributes[layout.related]);
  if (related === undefined) {
    return referencesAnyId(attributes[layout.related], scheduleIds) ? 'drop' : 'keep';
  }
  const remaining = related.filter(ref => !scheduleIds.has(ref.id));
  if (remaining.length === related.length) return 'keep';
  if (remaining.length === 0) return 'drop';
  attributes[layout.related] = `(${remaining.map(ref => ref.text).join(',')})`;
  return { attributesText: `(${attributes.join(',')})` };
}

function splitTopLevelAttributes(attributesText: string): string[] {
  if (!attributesText.startsWith('(') || !attributesText.endsWith(')')) return [];
  const inner = attributesText.slice(1, -1);
  const attributes: string[] = [];
  let start = 0;
  let depth = 0;
  let inString = false;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (inString) {
      if (c === "'") {
        if (inner[i + 1] === "'") i++;
        else inString = false;
      }
    } else if (c === "'") {
      inString = true;
    } else if (c === '(') {
      depth++;
    } else if (c === ')') {
      depth--;
    } else if (c === ',' && depth === 0) {
      attributes.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }
  attributes.push(inner.slice(start).trim());
  return attributes;
}

function parseStepRef(value: string): number | undefined {
  const match = /^#(\d+)$/.exec(value.trim());
  return match ? parseInt(match[1], 10) : undefined;
}

function splitReferenceAggregate(value: string): Array<{ id: number; text: string }> | undefined {
  // STEP allows `/* … */` comments between tokens; a reference aggregate
  // holds no string literals, so stripping them here is safe.
  const trimmed = value.replace(/\/\*[\s\S]*?\*\//g, '').trim();
  if (!trimmed.startsWith('(') || !trimmed.endsWith(')')) return undefined;
  const members = trimmed.slice(1, -1).split(',');
  const refs: Array<{ id: number; text: string }> = [];
  for (const member of members) {
    const text = member.trim();
    const id = parseStepRef(text);
    if (id === undefined) return undefined;
    refs.push({ id, text });
  }
  return refs;
}

interface StepEntityStatement {
  kind: 'entity';
  /** Byte offset of the `#` in `#ID=…`. */
  start: number;
  /** Byte offset just past the terminating `;`. */
  end: number;
  id: number;
  typeUpper: string;
  /** The parenthesised attribute list text including the outer parens. */
  attributesText: string;
}

/**
 * Tokenize `stepContent` into entity statements. Skips HEADER / DATA
 * section markers and whitespace; returns only `#ID=TYPE(…);` records.
 * Respects `'…'` string literals (STEP uses `''` to escape a quote).
 */
function tokenizeStepStatements(stepContent: string): StepEntityStatement[] {
  const out: StepEntityStatement[] = [];
  const len = stepContent.length;
  let i = 0;
  while (i < len) {
    // Skip whitespace.
    while (i < len && (stepContent[i] === ' ' || stepContent[i] === '\t' || stepContent[i] === '\n' || stepContent[i] === '\r')) i++;
    if (i >= len) break;
    // Only interested in `#N=…;` records. Anything else — header keywords,
    // section markers, end markers — gets scanned to the next `;` and
    // discarded as non-entity text.
    if (stepContent[i] !== '#') {
      // Scan to next `;` (STEP statements are `;`-terminated).
      i = scanToStatementEnd(stepContent, i);
      continue;
    }
    const declStart = i;
    i++; // past '#'
    // Read id digits.
    const idStart = i;
    while (i < len && stepContent.charCodeAt(i) >= 0x30 && stepContent.charCodeAt(i) <= 0x39) i++;
    if (i === idStart) {
      // `#` not followed by a digit — not an entity reference. Skip to `;`.
      i = scanToStatementEnd(stepContent, declStart + 1);
      continue;
    }
    const id = parseInt(stepContent.slice(idStart, i), 10);
    // Allow whitespace before `=`.
    while (i < len && (stepContent[i] === ' ' || stepContent[i] === '\t')) i++;
    if (stepContent[i] !== '=') {
      // `#N` without `=` — reference inside an attribute list; bail.
      i = scanToStatementEnd(stepContent, declStart + 1);
      continue;
    }
    i++; // past '='
    while (i < len && (stepContent[i] === ' ' || stepContent[i] === '\t')) i++;
    // Type name: uppercase letters, digits, underscore.
    const typeStart = i;
    while (i < len) {
      const c = stepContent[i];
      if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_' || (c >= 'a' && c <= 'z')) i++;
      else break;
    }
    if (i === typeStart) {
      i = scanToStatementEnd(stepContent, declStart + 1);
      continue;
    }
    const typeUpper = stepContent.slice(typeStart, i).toUpperCase();
    // Optional whitespace before attribute list.
    while (i < len && (stepContent[i] === ' ' || stepContent[i] === '\t' || stepContent[i] === '\n' || stepContent[i] === '\r')) i++;
    // Attribute list starts with `(`. Read until matching `)`, respecting
    // string literals and nested parens.
    const attrStart = i;
    if (stepContent[i] !== '(') {
      i = scanToStatementEnd(stepContent, declStart + 1);
      continue;
    }
    i++; // past '('
    let depth = 1;
    let inString = false;
    while (i < len && depth > 0) {
      const c = stepContent[i];
      if (inString) {
        if (c === "'") {
          // Peek for escape `''`.
          if (stepContent[i + 1] === "'") { i += 2; continue; }
          inString = false;
          i++;
          continue;
        }
        i++;
        continue;
      }
      if (c === "'") { inString = true; i++; continue; }
      if (c === '(') { depth++; i++; continue; }
      if (c === ')') { depth--; i++; continue; }
      i++;
    }
    const attrEnd = i;
    // Expect `;` terminator (optionally preceded by whitespace).
    while (i < len && (stepContent[i] === ' ' || stepContent[i] === '\t')) i++;
    if (stepContent[i] !== ';') {
      // Malformed — scan to next `;` and skip this record.
      i = scanToStatementEnd(stepContent, attrEnd);
      continue;
    }
    i++; // past ';'
    const end = i;
    out.push({
      kind: 'entity',
      start: declStart,
      end,
      id,
      typeUpper,
      attributesText: stepContent.slice(attrStart, attrEnd),
    });
  }
  return out;
}

/** Advance past the next `;` outside string literals. Never walks backwards. */
function scanToStatementEnd(s: string, from: number): number {
  const len = s.length;
  let i = from;
  let inString = false;
  while (i < len) {
    const c = s[i];
    if (inString) {
      if (c === "'") {
        if (s[i + 1] === "'") { i += 2; continue; }
        inString = false;
      }
      i++;
      continue;
    }
    if (c === "'") { inString = true; i++; continue; }
    if (c === ';') return i + 1;
    i++;
  }
  return len;
}

/** True iff any `#N` token in `rest` has N in the given set. */
function referencesAnyId(rest: string, ids: ReadonlySet<number>): boolean {
  const refRegex = /#(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = refRegex.exec(rest)) !== null) {
    const n = parseInt(m[1], 10);
    if (ids.has(n)) return true;
  }
  return false;
}
