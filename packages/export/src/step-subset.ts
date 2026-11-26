// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Raw STEP subset extraction: pull a handful of products out of a large IFC
 * into a small, VALID, standalone model. Records are copied byte-for-byte, so a
 * suspect element keeps reproducing outside the file it came from.
 *
 * The output carries each selected product's full forward reference closure
 * PLUS the shared context roots (IfcProject, unit assignment, geometric
 * contexts, and the backward closure of the selection's spatial ancestors, see
 * `step-subset-spatial-ancestors.ts`) and every spatial-structure relation, its
 * related-objects SET rewritten down to the kept members (see
 * `step-subset-relations.ts`), so the result parses and renders on its own.
 *
 * Consumers: `ifc-lite extract-entities` and the MCP `model_extract` tool.
 */
import { stepStringLiteralEnd } from '@ifc-lite/encoding';
import { expandTypes } from '@ifc-lite/parser';
import { getIfcRootTypes } from './subset-roots.js';
import { planSpatialRelations, refsOutsideStrings, splitTopLevelArgs, STRUCTURE_RELATION_ATTRS, SubsetSelectionError, type StepRecord, type Subset } from './step-subset-relations.js';
import { slotRef } from './schema-converter-structural-source.js';
import { skipStepTrivia } from './step-slot-grammar.js';
import { skipStepComment } from './step-comment-skip.js';
import { spatialAncestors } from './step-subset-spatial-ancestors.js';
import { resolveStorey, storeyMembers } from './step-subset-storey.js';

export { SubsetSelectionError } from './step-subset-relations.js';
export type { StepRecord, Subset } from './step-subset-relations.js';

export interface ParsedStep {
  header: string;
  instances: Map<number, StepRecord>;
  /** 22-char GlobalId → expressId, for rooted entities. */
  guidToId: Map<string, number>;
}

/** The first attribute's text when it is a string literal, read without splitting the whole body. */
function firstStringSlot(body: string): string | null {
  const start = skipStepTrivia(body, 0);
  if (start < 0 || body[start] !== "'") return null;
  const end = stepStringLiteralEnd(body, start);
  if (end < 0) return null;
  const after = skipStepTrivia(body, end);
  return after === body.length || body[after] === ',' ? body.slice(start + 1, end - 1) : null;
}

/** Index after the DATA section opener, ignoring header strings and comments, or -1. */
function findDataSection(text: string): number {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'") {
      const end = stepStringLiteralEnd(text, i);
      if (end < 0) return -1;
      i = end - 1;
    } else if (ch === '/' && text[i + 1] === '*') {
      i = skipStepComment(text, i) - 1;
    } else if (text.startsWith('DATA', i) && !/[A-Za-z0-9_]/.test(text[i - 1] ?? '')) {
      const end = skipStepTrivia(text, i + 4);
      if (text[end] === ';') return end + 1;
    }
  }
  return -1;
}

/** Voids, fills and projections: the relation pulls a feature in once its anchor (attribute 5) is kept. */
const ASSEMBLY_RELATIONS = new Set(['IFCRELAGGREGATES', 'IFCRELNESTS']);
const HOST_FEATURE_RELATIONS = new Set(['IFCRELVOIDSELEMENT', 'IFCRELFILLSELEMENT', 'IFCRELPROJECTSELEMENT']);

/**
 * String-aware STEP DATA tokenizer. Splits the data section into instances at
 * the `;` that terminates each `#id = TYPE(...)`, ignoring `;`/`#`/`(` inside
 * STEP string literals (`'...'`, where `''` is an escaped quote). A regex split
 * mis-fires on names containing `;` or `#` (common in Revit exports), so this
 * scans character by character instead.
 */
export function parseStep(text: string): ParsedStep {
  const headerEnd = findDataSection(text);
  if (headerEnd < 0) throw new Error('Not a STEP file: no DATA; section');
  // A record may follow the section opener on the same line.
  const header = text.slice(0, headerEnd) + '\n';
  const data = text;

  const instances = new Map<number, StepRecord>();
  const rooted = getIfcRootTypes();
  const guidToId = new Map<string, number>();

  let i = headerEnd;
  const n = data.length;
  while (i < n) {
    // Seek the next `#`
    while (i < n && data[i] !== '#') {
      // Comments between records are trivia, never a terminator.
      if (data[i] === '/' && data[i + 1] === '*') {
        i = skipStepComment(data, i);
        continue;
      }
      // Stop at ENDSEC to avoid scanning the footer.
      if (data.startsWith('ENDSEC', i)) {
        i = n;
        break;
      }
      i++;
    }
    if (i >= n) break;
    const hashStart = i;
    i++; // past '#'
    let idStr = '';
    while (i < n && data[i] >= '0' && data[i] <= '9') idStr += data[i++];
    if (idStr === '') continue; // a `#` inside something odd; skip
    // expect optional spaces then '='
    let j = skipStepTrivia(data, i);
    if (j < 0) break;
    if (data[j] !== '=') continue; // `#42` as a REFERENCE, not a definition
    j = skipStepTrivia(data, j + 1);
    if (j < 0) break; // an unclosed comment runs to the end
    // read TYPE
    let type = '';
    while (j < n && /[A-Za-z0-9_]/.test(data[j])) type += data[j++];
    // now consume the balanced `( ... )` respecting strings, then the ';'
    j = skipStepTrivia(data, j);
    if (j < 0) break;
    if (data[j] !== '(') continue; // not a record definition after all
    const bodyStart = j + 1;
    let depth = 0;
    for (; j < n; j++) {
      const ch = data[j];
      if (ch === '/' && data[j + 1] === '*') {
        // A comment's quotes and parentheses do not frame the record.
        j = skipStepComment(data, j) - 1;
      } else if (ch === "'") {
        // The shared literal-end rule (`''`, PAGE-directive operand, #7589).
        const end = stepStringLiteralEnd(data, j);
        j = end < 0 ? n : end - 1; // unterminated: runs to the end
        if (end < 0) break;
      } else if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) {
          j++;
          break;
        }
      }
    }
    const bodyEnd = j - 1; // index of the matching ')'
    const semi = skipStepTrivia(data, j);
    if (semi < 0 || semi >= n || depth !== 0) break;
    if (data[semi] !== ';') {
      // A malformed record must not consume the next well-formed one.
      i = semi;
      continue;
    }
    const id = parseInt(idStr, 10);
    const body = data.slice(bodyStart, bodyEnd);
    const full = data.slice(hashStart, semi + 1).trim();
    const upperType = type.toUpperCase();
    instances.set(id, { id, type: upperType, body, full, bodyStart: bodyStart - hashStart });
    // Only IfcRoot records carry a GlobalId (their first attribute); a property
    // or material whose first string happens to be 22 characters must not answer for one.
    if (rooted.has(upperType)) {
      const guid = firstStringSlot(body);
      if (guid?.length === 22) guidToId.set(guid, id);
    }
    i = semi + 1;
  }
  return { header, instances, guidToId };
}

/** Resolve one selector token to an expressId (`#42`, `42`, or a GlobalId).
 * An `#id` / bare id is validated against the model too, so a typo'd or stale
 * id fails loudly instead of silently selecting nothing. */
export function resolveToId(token: string, parsed: ParsedStep): number {
  const t = token.trim();
  const guidId = parsed.guidToId.get(t);
  if (guidId !== undefined) return guidId;
  if (t.startsWith('#') || /^\d+$/.test(t)) {
    if (!/^#?\d+$/.test(t)) throw new SubsetSelectionError('invalid', `Invalid expressId: ${t}`);
    const id = Number(t.replace(/^#/, ''));
    if (!parsed.instances.has(id)) throw new SubsetSelectionError('not-found', `expressId not found in model: #${id}`);
    return id;
  }
  throw new SubsetSelectionError('not-found', `GlobalId not found in model: ${t}`);
}

/**
 * Forward reference closure: every instance transitively referenced by
 * `seeds`.
 *
 * Uses `refsOutsideStrings`, not a raw `/#(\d+)/g` scan, because a record's
 * Name/Description is free TEXT and Revit writes `#`-shaped substrings into
 * it (`'Chair pairs with #71'`). A raw regex reads that as a reference to
 * entity 71 and pulls it — and its own closure — into the extraction even
 * though it was never selected. See #4148.
 *
 * An id NAMED but never DEFINED is not added, or a rewritten SET would emit
 * it as a dangling `#id` (#4128).
 */
export function forwardClosure(seeds: Iterable<number>, parsed: ParsedStep, into: Set<number>): void {
  const stack = [...seeds];
  while (stack.length) {
    const id = stack.pop()!;
    if (into.has(id)) continue;
    const rec = parsed.instances.get(id);
    if (!rec) continue;
    into.add(id);
    for (const ref of refsOutsideStrings(rec.body)) {
      if (!into.has(ref)) stack.push(ref);
    }
  }
}

/**
 * Assemble the subset: the closure of `seedProducts` + context roots
 * (project/units/contexts + the backward closure of spatial ancestors, not
 * the whole skeleton) + spatial-structure relations, each rewritten down to
 * its kept members (so no dangling references).
 */
export function buildSubset(seedProducts: Set<number>, parsed: ParsedStep): Subset {
  const keep = new Set<number>();
  forwardClosure(seedProducts, parsed, keep);

  // Openings, fillers and physical assembly parts point back to the selected
  // host through inverse relationships. Traverse them before adding spatial
  // context, so selecting an assembly never pulls in the contents of a storey.
  const inverse = new Map<number, number[]>();
  for (const inst of parsed.instances.values()) {
    const assembly = ASSEMBLY_RELATIONS.has(inst.type);
    if (!assembly && !HOST_FEATURE_RELATIONS.has(inst.type)) continue;
    const args = splitTopLevelArgs(inst.body);
    if (!args || args.length !== STRUCTURE_RELATION_ATTRS) continue;
    const anchor = slotRef(args[4]);
    if (anchor === null) continue;
    if (assembly) {
      if (parsed.instances.get(anchor)?.type !== 'IFCELEMENTASSEMBLY') continue;
      // Explicit part selections narrow the assembly's RelatedObjects set.
      if (refsOutsideStrings(args[5]).some((part) => seedProducts.has(part))) continue;
    }
    const relations = inverse.get(anchor);
    if (relations) relations.push(inst.id);
    else inverse.set(anchor, [inst.id]);
  }
  // Set iteration also visits new members. Each anchor and relation is handled
  // once, even for deep or cyclic assembly graphs.
  for (const id of keep) {
    const relations = inverse.get(id);
    if (relations) forwardClosure(relations, parsed, keep);
  }

  // Context roots: IfcProject (always — units/contexts hang off it even when
  // nothing selected reaches it) plus every spatial ancestor of what is
  // kept, closed forward. Backward closure, not a type list, so an unrelated
  // storey/space is never dragged in and a product under an IfcSpace or IFC4X3
  // facility class keeps its parent too (#4124). After the fixpoint, so a
  // filler or projection it pulled in keeps its own storey; ancestors are
  // spatial structures, never feature anchors, so the fixpoint needs none.
  const rootSeeds = spatialAncestors(keep, parsed.instances);
  for (const inst of parsed.instances.values()) {
    if (inst.type === 'IFCPROJECT') rootSeeds.push(inst.id);
  }
  forwardClosure(rootSeeds, parsed, keep);

  // Spatial relationships that connect kept products into the tree, each
  // relation's member SET filtered down to the kept ids rather than the whole
  // relation being dropped. `step-subset-relations.ts` owns that rule and the
  // no-dangling-reference invariant it preserves.
  let spatial = planSpatialRelations(parsed.instances.values(), keep);
  // A relation-private IfcOwnerHistory is reachable from nothing else, so the
  // plan drops the relation and reports what blocked it. Close over a dropped
  // relation's blocker group and replan (#4126), but only when EVERY id in the
  // group is a defined IfcOwnerHistory: then the closure keeps all of them and
  // that relation survives round two. A group holding anything else (a phantom
  // id, or a product named in a Name or Description slot, both schema-invalid)
  // leaves its relation dropped whatever is kept, so closing over it would only
  // emit records nothing references and drag unselected products in (#4150).
  // ONE replan, not a `while`: for a SCHEMA-VALID record an IfcOwnerHistory
  // subtree names no product, container or relation, so it blocks nothing new;
  // on invalid input a second round is discarded and the relation stays dropped
  // (never a dangling id).
  const owners = spatial.blockedOn
    .filter((ids) => ids.every((id) => parsed.instances.get(id)?.type === 'IFCOWNERHISTORY'))
    .flat();
  if (owners.length > 0) {
    forwardClosure(owners, parsed, keep);
    spatial = planSpatialRelations(parsed.instances.values(), keep);
  }
  for (const id of spatial.add) keep.add(id);
  return { keep, rewritten: spatial.rewritten };
}

/** Serialize the subset back into a valid STEP file (sorted, header preserved). */
export function serializeSubset({ keep, rewritten }: Subset, parsed: ParsedStep): string {
  const kept = [...keep].filter((id) => parsed.instances.has(id)).sort((a, b) => a - b);
  const lines = kept.map((id) => rewritten.get(id) ?? parsed.instances.get(id)!.full);
  return parsed.header + lines.join('\n') + '\nENDSEC;\nEND-ISO-10303-21;\n';
}

/** Selectors for {@link selectSubsetSeeds}; every selector is unioned. */
export interface SubsetSelectors {
  /** `#42`, `42`, or a 22-char GlobalId. Each must resolve, or it throws. */
  products?: readonly string[];
  /** IFC type names; subtypes are included (`IfcWall` selects `IfcWallStandardCase`). */
  types?: readonly string[];
  /** Storey GlobalId, `#id`/id, or name: the storey and its members (see `storeyMembers`). */
  storeys?: readonly string[];
  /** Throw `SubsetSelectionError('invalid')` for any type or storey that selects nothing. */
  requireEachMatch?: boolean;
  /** The file's schema, when known: subtypes are expanded for it alone rather than for the union of all schemas. */
  schemaVersion?: string;
}

/**
 * Resolve selectors to seed product ids. A product or storey token that names
 * nothing throws; a type that matches nothing just adds nothing, so the caller
 * decides how to word an empty selection.
 *
 * Types go through `expandTypes` for `selectors.schemaVersion`. Without one
 * (the CLI's own lightweight parse has no resolved schema) it expands for the
 * union of the bundled schemas, the case that union documents, rather than
 * picking one on the caller's behalf.
 */
export function selectSubsetSeeds(parsed: ParsedStep, selectors: SubsetSelectors): Set<number> {
  const seeds = new Set<number>();
  for (const token of selectors.products ?? []) {
    if (token.trim()) seeds.add(resolveToId(token, parsed));
  }
  // Expanded STEP type name -> the requested types it came from, so one scan
  // also tells which requested type matched nothing.
  const requested = (selectors.types ?? []).map((t) => t.trim()).filter(Boolean);
  const wantedTypes = new Map<string, number[]>();
  requested.forEach((type, i) => {
    for (const name of expandTypes([type], selectors.schemaVersion)) {
      const key = name.toUpperCase();
      const from = wantedTypes.get(key);
      if (from) from.push(i);
      else wantedTypes.set(key, [i]);
    }
  });
  const typeMatched = new Set<number>();
  if (wantedTypes.size > 0) {
    for (const inst of parsed.instances.values()) {
      const from = wantedTypes.get(inst.type);
      if (!from) continue;
      seeds.add(inst.id);
      for (const i of from) typeMatched.add(i);
    }
  }
  if (selectors.requireEachMatch) {
    const missing = requested.filter((_, i) => !typeMatched.has(i));
    if (missing.length > 0) throw new SubsetSelectionError('invalid', `No product of type ${missing.join(', ')} (or a subtype).`);
  }
  for (const token of selectors.storeys ?? []) {
    if (!token.trim()) continue;
    const { storeyId, placementId } = resolveStorey(token, parsed);
    // The storey itself is kept as asked, even if no product is contained in it.
    seeds.add(storeyId);
    const products = storeyMembers(storeyId, placementId, parsed, selectors.schemaVersion);
    if (selectors.requireEachMatch && products.length === 0) throw new SubsetSelectionError('invalid', `Storey ${token} has no elements.`);
    for (const id of products) seeds.add(id);
  }
  return seeds;
}
