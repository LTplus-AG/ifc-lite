// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Spatial-structure relations for an extracted subset: which ones join it, and
 * what text each one emits.
 *
 * `IfcRelContainedInSpatialStructure` is one-to-MANY, and a real exporter
 * writes exactly ONE of them per storey, naming every product in that storey.
 * An all-or-nothing rule (keep the relation only when every id it mentions is
 * kept) therefore drops containment on ANY strict subset of a real model: the
 * extracted products land outside the spatial tree and a viewer shows the
 * storey with nothing under it. So the `RelatedElements` SET is rewritten down
 * to the kept members instead of the relation being dropped.
 *
 * The no-dangling-reference invariant is unchanged (every `#id` in an emitted
 * record is an id the subset keeps), which is what the rest of the rules are:
 *   - the RELATING object (`RelatingStructure` / `RelatingObject`, the spatial
 *     parent) is a hard requirement. A containment with no parent is
 *     meaningless, and it would dangle. A KNOWN residual gap follows from that,
 *     and it is not this module's to close: `buildSubset` force-keeps only
 *     `IfcProject` / `IfcSite` / `IfcBuilding` / `IfcBuildingStorey`, so a
 *     product contained in an `IfcSpace` or `IfcSpatialZone` still has an
 *     unkept parent and still loses containment. Widening that type list is the
 *     wrong close, because it force-keeps every space AND its forward closure in
 *     every extraction; the right one is a BACKWARD closure from each kept
 *     product up its containment and aggregation edges, which keeps exactly the
 *     seeds' ancestors and needs no type list at all. Either way it is a change
 *     to how `buildSubset` seeds, not to the rule here. Filed as #4124.
 *   - every other non-set reference must be kept too. That is attribute 1,
 *     `OwnerHistory`; in practice it already is, because each kept product's
 *     own body names the same shared `IfcOwnerHistory` and the products'
 *     forward closure keeps it. A second REACHABLE residual lives here: an
 *     exporter that writes a PER-RELATIONSHIP `IfcOwnerHistory` referenced by
 *     nothing else hits this rule every time, and the relation is dropped, which
 *     is the orphaned-storey symptom again. `buildSubset` already has the remedy
 *     for that shape (it runs `forwardClosure` over the voids/fills relations it
 *     pulls in, for exactly this reason), but this function takes no `parsed`,
 *     so dropping is the only safe answer available HERE. Filed as #4126.
 *   - an empty intersection drops the relation.
 *
 * A relation that loses NO member re-emits its source line verbatim, so an
 * extraction that happened to keep every member does not churn.
 *
 * ## What this module re-implements, and why
 *
 * Three things here already exist in `@ifc-lite/export`, and all three are
 * copied for ONE reason: that package's `exports` map exposes only `.`, and its
 * `index.ts` re-exports none of them, so reaching any of them would mean adding
 * a published export (and an `api-surface` entry) to a v4.0.0 package in order
 * to fix a CLI bug.
 *
 *   - `filterHiddenRefsFromRelationshipLine` (`reference-collector.ts`) is the
 *     same job, done better: it filters EVERY parenthesised attribute of ANY
 *     `IFCREL*` line against an `isExcluded` predicate, so it needs no slot
 *     table at all, and it carries an edge case this module has no equivalent
 *     of (`IfcRelConnectsStructuralMember`'s optional trailing placement).
 *     Adopting it would delete most of this file. The export barrier above is
 *     the whole reason it is not adopted here, and nothing else: fed only
 *     today's three types it would change no behaviour, because the CALLER
 *     picks which lines it sees. Widening the type set is the separate decision,
 *     and that is the one that changes which relations survive an extraction.
 *     Consolidation follow-up: #4125.
 *   - `splitTopLevelStepArguments` (`step-argument-parser.ts`): see
 *     {@link splitTopLevelArgs}.
 *   - `STRUCTURE_RELATIONS` (`merged-empty-containers.ts`): three lines, see
 *     below.
 */

/**
 * One parsed STEP record, as `extract-entities.ts`'s `parseStep` produces it.
 * Declared HERE and imported there, rather than the other way round, so the
 * dependency runs one way: `extract-entities.ts` imports this module, never
 * the reverse.
 */
export interface StepRecord {
  id: number;
  type: string;
  /** Argument text between the outermost parentheses. */
  body: string;
  /** The verbatim `#id= TYPE(...);` text. */
  full: string;
}

/**
 * The assembled subset: the ids to emit, plus the record text to emit for the
 * relations whose related-objects SET was filtered. An id absent from
 * `rewritten` emits its source line unchanged.
 */
export interface Subset {
  keep: Set<number>;
  rewritten: ReadonlyMap<number, string>;
}

/** What {@link planSpatialRelations} found: relations to add, and their text. */
export interface SpatialRelationPlan {
  /** Relation ids that join the subset. */
  add: number[];
  /** Relation id → rewritten record text, for the ones that lost a member. */
  rewritten: Map<number, string>;
}

/**
 * Spatial-structure relations, as `[relatingAttributeIndex,
 * relatedAttributeIndex]`. `IfcRelAggregates` names the whole
 * (`RelatingObject`) first; the two containment relations name the parts
 * (`RelatedElements`) first. Same table as `STRUCTURE_RELATIONS` in
 * `@ifc-lite/export`'s `merged-empty-containers.ts`, which reads the same three
 * records, copied rather than imported because that module is internal to
 * `@ifc-lite/export` and exporting it would widen a published API surface for a
 * three-line constant.
 *
 * `IfcRelReferencedInSpatialStructure` is here for the same reason the other
 * two are: same shape (one relating parent, one related SET), same
 * one-per-storey authoring, same claim in the command's own docs that the
 * output "parses and renders on its own". It used to be missing entirely, so a
 * referenced-but-not-contained product was always orphaned.
 */
const STRUCTURE_RELATIONS: Record<string, [number, number]> = {
  IFCRELAGGREGATES: [4, 5],
  IFCRELCONTAINEDINSPATIALSTRUCTURE: [5, 4],
  IFCRELREFERENCEDINSPATIALSTRUCTURE: [5, 4],
};

/**
 * All three are `GlobalId, OwnerHistory, Name, Description` plus the
 * relating/related pair: exactly 6 attributes in every schema that defines
 * them. A record that does not split into 6 was mis-scanned (or is not the
 * entity the type name claims), so it falls back to keep-whole-or-drop-whole
 * rather than having a slot index written into whatever it did split into.
 *
 * A relation type with a different attribute COUNT (`IfcRelAssignsToGroup` has
 * 7) therefore cannot simply be added as a row above: it would fail this check
 * on every record and fall silently back to keep-whole-or-drop-whole, which is
 * the bug this module exists to fix. Such a type needs the count moved into the
 * table value first, or the whole table derived from the schema registry, which
 * returns 7 for that entity and would make row four safe rather than forbidden.
 * Filed as #4123.
 */
const STRUCTURE_RELATION_ATTRS = 6;

/** A single `#id` and nothing else: an object reference in one slot. */
const SINGLE_REF_RE = /^#(\d+)$/;

/**
 * Decide every spatial-structure relation against a kept-id set.
 *
 * Pure in both arguments: adding relation ids to `keep` afterwards cannot
 * change any verdict, because a relation of these types references products,
 * spatial containers and an OwnerHistory, never another relation.
 */
export function planSpatialRelations(
  instances: Iterable<StepRecord>,
  keep: ReadonlySet<number>,
): SpatialRelationPlan {
  const add: number[] = [];
  const rewritten = new Map<number, string>();
  for (const inst of instances) {
    const slots = STRUCTURE_RELATIONS[inst.type];
    if (slots === undefined) continue;
    const line = relationLine(inst, slots, keep);
    if (line === null) continue;
    add.push(inst.id);
    if (line !== inst.full) rewritten.set(inst.id, line);
  }
  return { add, rewritten };
}

/**
 * The record text this relation contributes to the subset, or null to drop it.
 * Returns `inst.full` unchanged when nothing was filtered out.
 */
function relationLine(
  inst: StepRecord,
  [relatingIdx, relatedIdx]: [number, number],
  keep: ReadonlySet<number>,
): string | null {
  // A null is a REJECTED scan, not an empty list: its parts are wherever the
  // scanner happened to be, so reading `args[relatingIdx]` or writing
  // `args[relatedIdx]` by index would land on the wrong attribute (#2470).
  const args = splitTopLevelArgs(inst.body);
  if (args === null || args.length !== STRUCTURE_RELATION_ATTRS) return keepWhole(inst, keep);

  const setText = args[relatedIdx];
  if (!setText.startsWith('(') || !setText.endsWith(')')) return keepWhole(inst, keep);
  const members = splitTopLevelArgs(setText.slice(1, -1));
  if (members === null) return keepWhole(inst, keep);
  const memberIds: number[] = [];
  for (const member of members) {
    const ref = SINGLE_REF_RE.exec(member);
    // A SET member that is not a plain object reference is not something this
    // rewrite understands; fall back rather than guess at it.
    if (ref === null) return keepWhole(inst, keep);
    memberIds.push(Number(ref[1]));
  }

  // The relating parent must be a real, kept reference. The `every reference
  // outside the SET is kept` loop below would pass VACUOUSLY on a `$` here,
  // emitting a containment with no parent.
  const relating = SINGLE_REF_RE.exec(args[relatingIdx]);
  if (relating === null || !keep.has(Number(relating[1]))) return null;

  // Every other non-set reference (OwnerHistory) must be kept or the emitted
  // record dangles.
  for (let i = 0; i < args.length; i++) {
    if (i === relatedIdx) continue;
    for (const id of refsOutsideStrings(args[i])) {
      if (!keep.has(id)) return null;
    }
  }

  const kept = memberIds.filter((id) => keep.has(id));
  if (kept.length === 0) return null;
  if (kept.length === memberIds.length) return inst.full;
  return spliceArgument(inst, args, relatedIdx, `(${kept.map((id) => `#${id}`).join(',')})`);
}

/**
 * The `#id` object references in one argument, ignoring any that sit inside a
 * STEP string literal.
 *
 * A relation's `Name` and `Description` are free TEXT, and free text contains
 * `#`; `parseStep` tokenizes rather than regexes precisely because Revit
 * writes names like that. Read raw, the `#99` in `'Level #99 contents'` looks
 * like a reference to entity 99, and one unkept lookalike drops the WHOLE
 * relation: the orphaned-storey bug this module exists to fix, re-created for
 * any model that names a relation that way.
 *
 * Correct only on an argument whose split VALIDATED, so the quote boundaries
 * are the record's own. {@link keepWhole} deliberately does NOT use this. It
 * runs when the split FAILED, and also when it succeeded but the record is not
 * the six-attribute shape this module rewrites, so its boundaries are not
 * established in general. There, over-counting references (drop the record) is
 * the safe error, while under-counting (emit a dangling `#id`) is not.
 *
 * Exported for `extract-entities.ts`'s `forwardClosure`, which has the same
 * hazard scanning a whole record body for its reference closure: nothing here
 * assumes `arg` is one split ARGUMENT rather than a whole body, since a comma
 * or `)` outside a string does not affect the in-string/out-of-string state
 * this walks.
 */
export function refsOutsideStrings(arg: string): number[] {
  const ids: number[] = [];
  let inString = false;
  for (let i = 0; i < arg.length; i++) {
    const char = arg[i];
    if (inString) {
      if (char === "'") {
        if (arg[i + 1] === "'") i++;
        else inString = false;
      }
      continue;
    }
    if (char === "'") {
      inString = true;
    } else if (char === '#') {
      let end = i + 1;
      while (end < arg.length && arg[end] >= '0' && arg[end] <= '9') end++;
      if (end > i + 1) ids.push(Number(arg.slice(i + 1, end)));
      i = end - 1;
    }
  }
  return ids;
}

/**
 * Keep-whole-or-drop-whole, for a record this module could not scan, or could
 * not read as its six attributes. Reads references straight off the raw body,
 * so it needs no argument boundaries to be correct. Same no-dangling guarantee,
 * no rewriting.
 */
function keepWhole(inst: StepRecord, keep: ReadonlySet<number>): string | null {
  const refs = [...inst.body.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
  return refs.length > 0 && refs.every((r) => keep.has(r)) ? inst.full : null;
}

/**
 * Re-emit the record with ONE top-level argument replaced. Rejoining the split
 * arguments normalizes only the whitespace BETWEEN them (each argument's own
 * text is untouched), and this runs only for a relation that actually lost a
 * member, so an unfiltered subset stays byte-identical.
 */
function spliceArgument(
  inst: StepRecord,
  args: string[],
  index: number,
  replacement: string,
): string | null {
  const open = inst.full.indexOf('(');
  // `body` is by construction the slice of `full` between its first `(` and the
  // matching `)`: the id and type name that precede it hold no parenthesis. A
  // mismatch would mean the parser and this module disagree about where the
  // arguments are, and splicing on that offset corrupts the record, so drop it
  // instead of emitting something malformed.
  if (open < 0 || inst.full.slice(open + 1, open + 1 + inst.body.length) !== inst.body) return null;
  const next = [...args];
  next[index] = replacement;
  return inst.full.slice(0, open + 1) + next.join(',') + inst.full.slice(open + 1 + inst.body.length);
}

/**
 * Split a STEP argument list on top-level commas, respecting nested
 * parentheses, quoted strings and doubled-quote escapes. Returns null when the
 * text is not a well-formed argument list.
 *
 * It VALIDATES rather than accepting whatever it accumulated, because
 * {@link relationLine} reads `RelatingStructure` by index and writes
 * `RelatedElements` by index, the situation #2470 names, where a mis-scanned
 * list still produces parts and a slot written into those parts lands on the
 * wrong argument while reporting success.
 *
 * Rejected, because after any of these the parts are no longer the record's
 * attributes: commas were swallowed and everything past them shifted:
 *   - a quote still open at the end (unterminated string);
 *   - a paren depth that does not return to zero at the end (unbalanced list);
 *   - a depth that ever goes NEGATIVE (stray closing paren). Both ends matter:
 *     a depth that dips below zero and climbs back looks balanced at the end
 *     while every comma in between was read as nested.
 *
 * An EMPTY INTERIOR slot (`a,,b`) is deliberately NOT rejected: it is one part,
 * exactly as an entity parser counts it, so every later index still names the
 * attribute it is meant to.
 *
 * Near-twin, not a copy, of `@ifc-lite/export`'s `splitTopLevelStepArguments`
 * (see the module header for why it is not imported). Two MEASURED differences,
 * both wanted here and neither shared with that function:
 *   - each part is `trim`med, because {@link SINGLE_REF_RE} is anchored;
 *   - a TRAILING empty slot (`a,b,`) yields 2 parts, not 3. So a SIX-attribute
 *     record with a stray trailing comma still counts as six, is rewritten, and
 *     loses that comma in the output; a five-attribute one is rejected by the
 *     attribute-count check instead. Invalid STEP in, valid STEP out, and the
 *     slot indices are the ones the record meant either way.
 */
function splitTopLevelArgs(text: string): string[] | null {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let inString = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (inString) {
      if (char === "'") {
        // A doubled quote is an escaped quote, not the end of the string.
        if (text[i + 1] === "'") i++;
        else inString = false;
      }
      continue;
    }

    if (char === "'") {
      inString = true;
    } else if (char === '(') {
      depth++;
    } else if (char === ')') {
      depth--;
      if (depth < 0) return null;
    } else if (char === ',' && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }

  if (inString || depth !== 0) return null;
  const tail = text.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}
