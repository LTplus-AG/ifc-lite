#!/usr/bin/env tsx
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ifc-git REVISION CHAIN deriver (issue #8128).
 *
 * The fixture corpus catalogues 182 standalone models and no version history,
 * so nothing in the repo can exercise `log`, `rebase`, compare-and-swap, or —
 * most importantly — the GUID-agnostic claim. This script derives a
 * deterministic CHAIN from the committed base bytes: each revision is applied
 * to the PREVIOUS revision, which is what a history actually is, rather than a
 * star of independent variants off one base.
 *
 * Base: `apps/viewer/public/samples/building-architecture.ifc` (committed, 226
 * KB, IFC4, exported by IFC-manager for SketchUp). The base file is never
 * modified. Same pattern as `tools/demo-kit/derive-variants.mts`, which derives
 * a single `-rev-b` variant for the tours walkthrough.
 *
 * Outputs:
 *   - <out>/r00..r11 .ifc           the chain (NOT committed; regenerate)
 *   - tools/ifc-git-corpus/revisions.json   committed manifest, SHA-256 pinned
 *
 * Every declared change is SELF-VERIFIED by running the real diff engine
 * between consecutive revisions: the counts, the modified/deleted `GlobalId`s
 * and the changed component keys are each compared against the declaration, and
 * a contradiction fails the run BEFORE the manifest is written.
 *
 * Revisions built around a SHARED property set declare the sharing itself —
 * the definition's `GlobalId`, its `Name`, and every consumer — and it is
 * checked structurally, against the schema's uniqueness rule, and through the
 * engine's own per-component hashes. Counts and `GlobalId`s alone cannot tell
 * a shared definition from two same-named copies; see
 * {@link checkSharedDefinition}.
 *
 * A plain run REWRITES the manifest, so by itself it proves only that this
 * engine satisfies the current declarations — not that the committed manifest
 * still holds. `--check` closes that gap: same derivation, compared
 * byte-for-byte against the committed file, nothing written.
 *
 * Verification scope is `data`, deliberately: it needs no geometry pipeline and
 * therefore executes no WASM. It still needs an installed and CURRENT workspace
 * build — `@ifc-lite/wasm` has to resolve for `packages/diff` to load at all.
 * Revisions whose change is geometric are marked `geometryScopeRequired` in the
 * manifest — their bytes are correct, but proving the change needs the geometry
 * lane.
 *
 * Run from the repo root:
 *   pnpm install # links @ifc-lite/wasm into packages/diff
 *   pnpm build   # or at least packages/{parser,diff,cli,encoding}
 *   pnpm tsx tools/ifc-git-corpus/derive-revisions.mts [--check]
 *
 * Exit codes:
 *   0  derivation matches the committed manifest (`--check`), or the manifest
 *      was rewritten (plain run)
 *   1  the derivation CONTRADICTS the declarations or the committed manifest
 *   3  prerequisites absent -- nothing was derived, so nothing was checked.
 *      A CI lane may skip on this and must not skip on 1.
 *
 * Deliberately not run in CI without `--check`: a plain run WRITES the manifest
 * the tests then check, so regenerating in CI would let a drifting engine
 * rewrite its own expectations.
 *
 * Why this file re-execs itself: the repo root tsconfig maps some `@ifc-lite/*`
 * names to their `dist/index.d.ts`, and tsx's tsconfig-paths resolver loads a
 * `.d.ts` AS the runtime module for bare specifiers anywhere in the graph,
 * silently producing an incomplete module. Pinning TSX_TSCONFIG_PATH at the
 * alias-free local tsconfig makes bare specifiers resolve through node_modules
 * instead. Pre-existing repo gotcha, documented at length in
 * `tools/demo-kit/tsconfig.json`.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename_ = fileURLToPath(import.meta.url);
const __dirname_ = path.dirname(__filename_);
const REPO_ROOT = path.resolve(__dirname_, '../..');
const LOCAL_TSCONFIG = path.join(__dirname_, 'tsconfig.json');

if (!process.env.IFC_LITE_CORPUS_BOOTSTRAPPED) {
  const { status } = spawnSync('pnpm', ['exec', 'tsx', __filename_, ...process.argv.slice(2)], {
    stdio: 'inherit',
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      TSX_TSCONFIG_PATH: LOCAL_TSCONFIG,
      IFC_LITE_CORPUS_BOOTSTRAPPED: '1',
    },
  });
  process.exit(status ?? 1);
}

/**
 * Exit code for "the inputs this needs are not here".
 *
 * Deliberately distinct from 1. A CI lane has to tell two situations apart: the
 * manifest DISAGREES with a fresh derivation (a real failure, exit 1), and the
 * built output needed to derive anything is absent (not a failure of this
 * check, exit 3). Collapsing both into 1 forces a lane to choose between
 * failing on an unbuilt tree and hiding a genuine mismatch behind `|| true`,
 * and `|| true` is how a gate stops gating.
 *
 * The skip stays narrow on purpose: only these paths, only absence. A
 * derivation that runs and disagrees always exits 1.
 */
const PREREQUISITES_ABSENT = 3;

const REQUIRED_PATHS = [
  'packages/parser/dist/index.js',
  'packages/diff/dist/index.js',
  'packages/encoding/dist/index.js',
  'packages/cli/dist/commands/diff-engine.js',
  // The base model every revision is derived from. Committed, not a fetched
  // fixture -- but a sparse or partial checkout can still be without it, and
  // deriving from a missing base would otherwise fail deep inside the parser.
  'apps/viewer/public/samples/building-architecture.ifc',
];
const missing = REQUIRED_PATHS.filter((p) => !existsSync(path.join(REPO_ROOT, p)));
if (missing.length > 0) {
  console.error(
    `Prerequisites absent:\n  ${missing.join('\n  ')}\n\n` +
      'Run `pnpm install && pnpm build` first.\n\n' +
      `Exiting ${PREREQUISITES_ABSENT} rather than 1, so a CI lane can skip on absent ` +
      'inputs without also skipping a real mismatch. A mismatch exits 1.',
  );
  process.exit(PREREQUISITES_ABSENT);
}

const { IfcParser } = await import('../../packages/parser/dist/index.js');
const { diffModels } = await import('../../packages/diff/dist/index.js');
const { uuidFromSeed, uuidToIfcGuid, isValidIfcGuid } = await import(
  '../../packages/encoding/dist/index.js'
);
const { buildFileFingerprints } = await import(
  '../../packages/cli/dist/commands/diff-engine.js'
);

const SAMPLES_DIR = path.join(REPO_ROOT, 'apps/viewer/public/samples');
const BASE_FILE = path.join(SAMPLES_DIR, 'building-architecture.ifc');
const MANIFEST_FILE = path.join(__dirname_, 'revisions.json');
const OUT_DIR = process.env.IFC_GIT_CORPUS_OUT ?? path.join(REPO_ROOT, 'tests/models/local/ifc-git-corpus');
/** `--check` verifies the committed manifest instead of rewriting it. */
const CHECK_ONLY = process.argv.slice(2).includes('--check');

// ---------------------------------------------------------------------------
// STEP text helpers. Text-level on purpose: a revision must be able to change
// the header and regenerate GlobalIds, neither of which survives a
// parse/re-serialize round trip unchanged.
// ---------------------------------------------------------------------------

const STEP_LINE_RE = /^#(\d+)=([A-Z0-9_]+)\((.*)\);\s*$/;
/** The 64-character IFC GUID alphabet, 22 characters wide. */
const IFC_GUID_RE = /^[0-9A-Za-z_$]{22}$/;

interface StepLine {
  readonly index: number;
  readonly id: number;
  readonly type: string;
  readonly args: string;
}

function indexLines(lines: readonly string[]): Map<number, StepLine> {
  const out = new Map<number, StepLine>();
  lines.forEach((line, index) => {
    const m = STEP_LINE_RE.exec(line);
    if (m) out.set(Number(m[1]), { index, id: Number(m[1]), type: m[2], args: m[3] });
  });
  return out;
}

/** Split top-level STEP arguments, respecting quotes and nesting. */
function splitArgs(args: string): string[] {
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

function findByType(index: Map<number, StepLine>, type: string): StepLine[] {
  return [...index.values()].filter((l) => l.type === type).sort((a, b) => a.id - b.id);
}

function requireOne(lines: StepLine[], what: string): StepLine {
  if (lines.length === 0) throw new Error(`base model has no ${what}`);
  return lines[0];
}

/** Replace one whole record, keeping its position. */
function rewriteRecord(lines: string[], line: StepLine, args: readonly string[]): void {
  lines[line.index] = `#${line.id}=${line.type}(${args.join(',')});`;
}

function globalIdOf(line: StepLine): string | null {
  const first = splitArgs(line.args)[0] ?? '';
  const m = /^'(.*)'$/.exec(first);
  if (!m) return null;
  return IFC_GUID_RE.test(m[1]) && isValidIfcGuid(m[1]) ? m[1] : null;
}

/** Every record whose arg[0] is a GlobalId — i.e. every `IfcRoot`. */
function rootedLines(index: Map<number, StepLine>): StepLine[] {
  return [...index.values()].filter((l) => globalIdOf(l) !== null).sort((a, b) => a.id - b.id);
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * How many OTHER records reference `#id`. The record's own declaration is not a
 * reference, so it is discounted.
 */
function referenceCount(lines: readonly string[], target: StepLine): number {
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
function stepReal(value: number): string {
  const text = String(value);
  return /[.eE]/.test(text) ? text : `${text}.`;
}

// ---------------------------------------------------------------------------
// Revision transforms. Each takes the previous revision's text and returns the
// next, plus the facts the manifest records.
// ---------------------------------------------------------------------------

/**
 * A claim that ONE property set definition is shared by several elements.
 *
 * `touched` alone cannot carry this: a revision that silently un-shared the set
 * and instead gave each element its own copy would still touch the same
 * `GlobalId`s and still move the same component key. So the sharing itself is
 * declared and verified — the definition by `GlobalId` (never its express id,
 * which `r08` does not preserve and which no consumer of the manifest can
 * resolve), and the full set of consumers.
 */
interface SharedDefinition {
  /** `Name` of the shared `IfcPropertySet`, i.e. the `pset:<name>` component. */
  readonly name: string;
  /** `GlobalId` of the single definition record. */
  readonly definition: string;
  /** `GlobalId` of every element expected to reference it — exactly, not at least. */
  readonly consumers: readonly string[];
}

interface Applied {
  readonly text: string;
  /** GlobalIds the change is expected to touch. Empty for a no-op revision. */
  readonly touched: readonly string[];
  /** Component keys the change is expected to move, where data-scope can see them. */
  readonly expectComponents: readonly string[];
  /** Set when the revision's point is a shared definition. Verified structurally AND through the engine. */
  readonly shared?: SharedDefinition;
  readonly note?: string;
}

type Transform = (text: string) => Applied;

/** The wall whose own property set is edited, and the type whose set is edited. */
function pickWall(index: Map<number, StepLine>): StepLine {
  return requireOne(findByType(index, 'IFCWALL'), 'IfcWall');
}

/**
 * Does `args` reference `#id`? Boundary-anchored on purpose: a plain substring
 * test makes `#26` match `#262`, which would silently resolve the wrong owner.
 */
function refersTo(args: string, id: number): boolean {
  return new RegExp(`#${id}(?![0-9])`).test(args);
}

/** One `IfcRelDefinesByProperties` and the `IfcPropertySet` it relates. */
interface PsetAssociation {
  readonly rel: StepLine;
  readonly pset: StepLine;
}

/**
 * EVERY property set attached to `ownerId` through `IfcRelDefinesByProperties`,
 * with the relationship that attaches it. All of them, not the first: the
 * schema rule this file has to respect — `IfcObject.UniquePropertySetNames`,
 * via `IfcUniqueDefinitionNames` — is a statement about the whole collection,
 * so anything that wants to honour it has to see the whole collection.
 */
function psetAssociationsOf(index: Map<number, StepLine>, ownerId: number): PsetAssociation[] {
  const out: PsetAssociation[] = [];
  for (const rel of findByType(index, 'IFCRELDEFINESBYPROPERTIES')) {
    const args = splitArgs(rel.args);
    if (!refersTo(args[4] ?? '', ownerId)) continue;
    const psetRef = /#(\d+)/.exec(args[5] ?? '');
    if (!psetRef) continue;
    const pset = index.get(Number(psetRef[1]));
    if (pset && pset.type === 'IFCPROPERTYSET') out.push({ rel, pset });
  }
  return out;
}

/** Find the property set attached to `ownerId` through IfcRelDefinesByProperties. */
function psetOf(index: Map<number, StepLine>, ownerId: number): StepLine {
  const first = psetAssociationsOf(index, ownerId)[0];
  if (!first) throw new Error(`no IfcPropertySet reachable from #${ownerId}`);
  return first.pset;
}

function psetName(line: StepLine): string {
  const m = /^'(.*)'$/.exec(splitArgs(line.args)[2] ?? '');
  return m ? m[1] : '';
}

/** First IfcPropertySingleValue inside a property set, with its current value. */
function firstProperty(index: Map<number, StepLine>, pset: StepLine): StepLine {
  const members = splitArgs(pset.args)[4] ?? '';
  for (const ref of members.matchAll(/#(\d+)/g)) {
    const prop = index.get(Number(ref[1]));
    if (prop && prop.type === 'IFCPROPERTYSINGLEVALUE') return prop;
  }
  throw new Error(`property set #${pset.id} has no IfcPropertySingleValue`);
}

/** Bump a property's value deterministically, whatever its wrapped type. */
function bumpPropertyValue(args: string[]): string[] {
  const next = [...args];
  const value = next[2] ?? '$';
  const text = /^IFC[A-Z]+\('(.*)'\)$/.exec(value);
  if (text) {
    next[2] = value.replace(`'${text[1]}'`, `'${text[1]}-rev'`);
    return next;
  }
  const num = /^(IFC[A-Z]+)\((-?[\d.]+)\)$/.exec(value);
  if (num) {
    next[2] = `${num[1]}(${Number(num[2]) + 1})`;
    return next;
  }
  const bool = /^IFCBOOLEAN\(\.([TF])\.\)$/.exec(value);
  if (bool) {
    next[2] = `IFCBOOLEAN(.${bool[1] === 'T' ? 'F' : 'T'}.)`;
    return next;
  }
  throw new Error(`cannot bump property value ${value}`);
}

const editOwnPropertySet: Transform = (text) => {
  const lines = text.split('\n');
  const index = indexLines(lines);
  const wall = pickWall(index);
  const pset = psetOf(index, wall.id);
  const prop = firstProperty(index, pset);
  rewriteRecord(lines, prop, bumpPropertyValue(splitArgs(prop.args)));
  return {
    text: lines.join('\n'),
    touched: [globalIdOf(wall)!],
    expectComponents: [`pset:${psetName(pset)}`],
  };
};

/**
 * The element's OWN placement origin: `ObjectPlacement` -> `RelativePlacement`
 * -> `Location`. Resolved rather than guessed, because the lowest-id
 * `IfcCartesianPoint` in a real export is the world origin shared by the
 * geometric representation context and the site placement -- shifting that
 * moves the whole model, which would make a single-element `touched` claim a
 * lie.
 */
function placementPointOf(index: Map<number, StepLine>, element: StepLine): StepLine {
  const step = (from: StepLine, slot: number, want: RegExp, what: string): StepLine => {
    const ref = /#(\d+)/.exec(splitArgs(from.args)[slot] ?? '');
    const target = ref ? index.get(Number(ref[1])) : undefined;
    if (!target || !want.test(target.type)) {
      throw new Error(`#${from.id} (${from.type}) has no ${what} at attribute ${slot}`);
    }
    return target;
  };
  const placement = step(element, 5, /^IFCLOCALPLACEMENT$/, 'IfcLocalPlacement');
  const axis = step(placement, 1, /^IFCAXIS2PLACEMENT[23]D$/, 'IfcAxis2Placement');
  return step(axis, 0, /^IFCCARTESIANPOINT$/, 'IfcCartesianPoint');
}

const moveElement: Transform = (text) => {
  const lines = text.split('\n');
  const index = indexLines(lines);
  const wall = pickWall(index);
  const point = placementPointOf(index, wall);
  // Exactly one consumer, the IfcAxis2Placement resolved above. A shared point
  // would move every element hanging off it, and the `touched` claim below says
  // one.
  const consumers = referenceCount(lines, point);
  if (consumers !== 1) {
    throw new Error(
      `placement point #${point.id} has ${consumers} consumers; ` +
        `moving it would move more than #${wall.id}`,
    );
  }
  const coords = splitArgs(splitArgs(point.args)[0].replace(/^\(|\)$/g, ''));
  // Shift X only, preserving the point's arity -- a 2D point has no coords[2].
  const shifted = `(${[stepReal(Number(coords[0]) + 250), ...coords.slice(1)].join(',')})`;
  rewriteRecord(lines, point, [shifted]);
  return {
    text: lines.join('\n'),
    touched: [globalIdOf(wall)!],
    expectComponents: [],
    note: 'geometric: data scope sees nothing, by design',
  };
};

const renameElement: Transform = (text) => {
  const lines = text.split('\n');
  const index = indexLines(lines);
  const wall = pickWall(index);
  const args = splitArgs(wall.args);
  args[2] = args[2] === '$' ? "'Renamed Wall'" : args[2].replace(/'$/, " (renamed)'");
  rewriteRecord(lines, wall, args);
  return { text: lines.join('\n'), touched: [globalIdOf(wall)!], expectComponents: ['attr:core'] };
};

const editTypeObjectPropertySet: Transform = (text) => {
  const lines = text.split('\n');
  const index = indexLines(lines);
  // A type's sets hang off its own `HasPropertySets` slot (attribute index 5
  // on every `IfcTypeObject`), not off an `IfcRelDefinesByProperties`. Most
  // type objects in a real export leave it `$` -- in this base only the slab
  // type carries one -- so scan rather than assume a class.
  const candidates = [...index.values()]
    .filter((l) => /^IFC[A-Z0-9_]+TYPE$/.test(l.type) && globalIdOf(l) !== null)
    .sort((a, b) => a.id - b.id);
  const found = candidates
    .map((type) => ({ type, ref: /#(\d+)/.exec(splitArgs(type.args)[5] ?? '') }))
    .find((c) => c.ref !== null && index.get(Number(c.ref[1]))?.type === 'IFCPROPERTYSET');
  if (!found) {
    throw new Error(
      `no IfcTypeObject with HasPropertySets among ${candidates.length} type objects`,
    );
  }
  const type = found.type;
  const pset = index.get(Number(found.ref![1]))!;
  const prop = firstProperty(index, pset);
  rewriteRecord(lines, prop, bumpPropertyValue(splitArgs(prop.args)));
  return {
    text: lines.join('\n'),
    touched: [globalIdOf(type)!],
    expectComponents: [`pset:${psetName(pset)}`],
  };
};

/**
 * Take `memberId` out of a relationship's `RelatedObjects`, returning the line
 * indices the caller must drop.
 *
 * `RelatedObjects` is `SET [1:?]`, so a relationship left relating nothing is
 * schema-invalid and has to GO rather than ship as `()` — the same rule
 * `deleteElement` applies, for the same reason: every later revision is applied
 * to this text, so one invalid record poisons the rest of the chain.
 */
function removeRelatedObject(lines: string[], rel: StepLine, memberId: number): number[] {
  const args = splitArgs(rel.args);
  const members = [...(args[4] ?? '').matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
  const remaining = members.filter((id) => id !== memberId);
  if (remaining.length === members.length) {
    throw new Error(`#${rel.id} (${rel.type}) does not relate #${memberId}`);
  }
  if (remaining.length > 0) {
    args[4] = `(${remaining.map((id) => `#${id}`).join(',')})`;
    rewriteRecord(lines, rel, args);
    return [];
  }
  if (referenceCount(lines, rel) !== 0) {
    throw new Error(
      `#${rel.id} (${rel.type}) is emptied by detaching #${memberId} but is itself referenced`,
    );
  }
  return [rel.index];
}

/**
 * Share ONE property set definition between the first two walls.
 *
 * The obvious construction — add the second wall to the relationship that
 * already defines the first — is wrong, and was the defect reviewed on #8129.
 * Both walls in this base carry their own `Pset_WallCommon`, so adding leaves
 * the second wall with TWO sets of that name, which violates
 * `IfcObject.UniquePropertySetNames` (bundled `IFC4_ADD2_TC1.exp`, via
 * `IfcUniqueDefinitionNames`) in this revision and, because the chain applies
 * each revision to the previous text, in every revision after it.
 *
 * It also quietly destroys the measurement the revision exists to make.
 * `buildComponentFingerprints` assigns `components['pset:' + set.name]` in a
 * loop, so the second same-named set OVERWRITES the first: the duplicate shows
 * up as a moved whole-entity `dataHash` with an EMPTY `changedComponents`, and
 * the later edit to the "shared" set is measured on whichever copy happened to
 * win. A shared-node case cannot be established that way.
 *
 * So REPLACE: detach the second wall from its own same-named association
 * (which leaves that relationship empty, hence dropped) and attach it to the
 * first wall's. One definition, two consumers, one `Pset_WallCommon` each.
 */
const sharePropertySet: Transform = (text) => {
  const lines = text.split('\n');
  const index = indexLines(lines);
  const walls = findByType(index, 'IFCWALL');
  if (walls.length < 2) throw new Error('need two IfcWalls to share a property set');
  const [first, second] = walls;

  const sharing = psetAssociationsOf(index, first.id).find(
    (a) => !refersTo(splitArgs(a.rel.args)[4] ?? '', second.id),
  );
  if (!sharing) {
    throw new Error(`no IfcRelDefinesByProperties defines #${first.id} without #${second.id}`);
  }
  const name = psetName(sharing.pset);
  if (name === '') throw new Error(`property set #${sharing.pset.id} has no Name to share`);

  // Resolved by NAME, never by express id: the id that has to go is whichever
  // one would collide, and this transform also has to hold if the base model
  // is ever re-exported with different ids.
  const superseded = psetAssociationsOf(index, second.id).filter(
    (a) => psetName(a.pset) === name,
  );
  if (superseded.length !== 1) {
    throw new Error(
      `#${second.id} carries ${superseded.length} property sets named '${name}'; ` +
        'expected exactly one to supersede',
    );
  }

  const dropped = new Set<number>();
  for (const a of superseded) {
    for (const i of removeRelatedObject(lines, a.rel, second.id)) dropped.add(i);
  }
  const args = splitArgs(sharing.rel.args);
  args[4] = (args[4] ?? '').replace(/\)$/, `,#${second.id})`);
  rewriteRecord(lines, sharing.rel, args);

  // Counted, not assumed: a superseded set is only detached if nothing else
  // still relates it, and the relationship is only dropped if detaching the
  // wall emptied it.
  const nextLines = lines.filter((_, i) => !dropped.has(i));
  const nextIndex = indexLines(nextLines);
  const detached = superseded
    .map((a) => nextIndex.get(a.pset.id))
    .filter((l): l is StepLine => l !== undefined && referenceCount(nextLines, l) === 0);

  const consumers = [globalIdOf(first)!, globalIdOf(second)!];
  return {
    text: nextLines.join('\n'),
    // Only the second wall moves: it swaps its own copy for the first wall's
    // definition. The first wall's data is untouched.
    touched: [globalIdOf(second)!],
    expectComponents: [`pset:${name}`],
    shared: { name, definition: globalIdOf(sharing.pset)!, consumers },
    note:
      `the second wall's own '${name}' (#${superseded.map((a) => a.pset.id).join(', #')}) is ` +
      `superseded by the first wall's definition (#${sharing.pset.id}), so the set is shared ` +
      `rather than duplicated; ${dropped.size} relationship record(s) left with an empty ` +
      `related set were dropped, and ${detached.length} superseded set(s) stay in the file ` +
      'referenced by nothing -- what a real detach leaves behind, and schema-valid.',
  };
};

const editSharedPropertySet: Transform = (text) => {
  const lines = text.split('\n');
  const index = indexLines(lines);
  const walls = findByType(index, 'IFCWALL');
  if (walls.length < 2) throw new Error('need two IfcWalls for a shared property set');
  const [first, second] = walls;
  // The definition both walls ACTUALLY point at, not "the first set reachable
  // from the first wall". If r06 ever stops sharing, this throws instead of
  // editing an unshared set and still reporting two element markers, which is
  // exactly how the duplicate-set defect stayed invisible.
  const shared = psetAssociationsOf(index, first.id).find((a) =>
    refersTo(splitArgs(a.rel.args)[4] ?? '', second.id),
  );
  if (!shared) {
    throw new Error(
      `no IfcRelDefinesByProperties relates both #${first.id} and #${second.id}; r06 did not share`,
    );
  }
  const prop = firstProperty(index, shared.pset);
  rewriteRecord(lines, prop, bumpPropertyValue(splitArgs(prop.args)));
  const name = psetName(shared.pset);
  const consumers = [globalIdOf(first)!, globalIdOf(second)!];
  return {
    text: lines.join('\n'),
    touched: consumers,
    expectComponents: [`pset:${name}`],
    shared: { name, definition: globalIdOf(shared.pset)!, consumers },
    note: 'one node change, two element markers -- the localisation payoff',
  };
};

const deleteElement: Transform = (text) => {
  const lines = text.split('\n');
  const index = indexLines(lines);
  const furniture = findByType(index, 'IFCFURNITURE');
  const victim = requireOne(furniture.length > 0 ? furniture : findByType(index, 'IFCWALL'), 'deletable element');
  const gid = globalIdOf(victim)!;

  // Scrubbing a reference out of a POSITIONAL slot would leave the record one
  // argument short -- silently, and invisibly to the diff. Only list membership
  // is safe to scrub, so refuse anything else rather than corrupt the record.
  const soleMember = new RegExp(`\\(#${victim.id}(?![0-9])\\)`);
  const orphaned: StepLine[] = [];
  for (const line of index.values()) {
    if (line.id === victim.id) continue;
    for (const arg of splitArgs(line.args)) {
      if (!refersTo(arg, victim.id)) continue;
      if (!/^\(.*\)$/.test(arg.trim())) {
        throw new Error(
          `#${victim.id} is a positional argument of #${line.id} (${line.type}); ` +
            'scrubbing it would shift that record\'s arguments',
        );
      }
    }
    // A relationship that related ONLY the victim has nothing left to relate,
    // and `RelatedObjects` is `SET [1:?]` -- emptying it to `()` would ship a
    // schema-invalid record into this and EVERY later revision, since each
    // revision applies to the previous text. A real deletion removes the
    // relationship, so drop it rather than empty it.
    if (soleMember.test(line.args)) {
      if (referenceCount(lines, line) !== 0) {
        throw new Error(
          `#${line.id} (${line.type}) is emptied by deleting #${victim.id} but is itself referenced`,
        );
      }
      orphaned.push(line);
    }
  }

  const drop = new Set<number>([victim.index, ...orphaned.map((l) => l.index)]);
  const scrubbed = lines
    .filter((_, i) => !drop.has(i))
    .map((line) =>
      line
        .replace(new RegExp(`#${victim.id}(?![0-9]),`, 'g'), '')
        .replace(new RegExp(`,#${victim.id}(?![0-9])`, 'g'), ''),
    );
  return {
    text: scrubbed.join('\n'),
    touched: [gid],
    expectComponents: [],
    note:
      orphaned.length === 0
        ? undefined
        : `also drops ${orphaned.length} relationship record(s) left with an empty related set: ${orphaned
            .map((l) => `#${l.id} ${l.type}`)
            .join(', ')}`,
  };
};

const reExportRegeneratingGuids: Transform = (text) => {
  const lines = text.split('\n');
  const index = indexLines(lines);
  const roots = rootedLines(index);
  let out = text;
  for (const line of roots) {
    const old = globalIdOf(line)!;
    const fresh = uuidToIfcGuid(uuidFromSeed(`ifc-git-corpus:reguid:${old}`));
    if (fresh === old) throw new Error(`re-GUID produced the same id for ${old}`);
    out = out.split(`'${old}'`).join(`'${fresh}'`);
  }
  // A real from-scratch export also moves the header clock and the owner
  // history dates. Both are pure noise to a version, and both are what makes
  // a byte comparison useless.
  out = out.replace(
    /FILE_NAME\('([^']*)','([^']*)'/,
    (_m, name) => `FILE_NAME('${name}','2026-02-02T09:00:00'`,
  );
  out = out.replace(/\b1731578952\b/g, '1770022800');
  return {
    text: out,
    touched: [],
    expectComponents: [],
    note: `every GlobalId regenerated (${roots.length} rooted entities), header clock and owner-history dates moved; nothing semantic changed`,
  };
};

const byteIdenticalResave: Transform = (text) => ({
  text,
  touched: [],
  expectComponents: [],
  note: 'byte-identical: must produce no commit',
});

interface RevisionSpec {
  readonly id: string;
  readonly changeClass: string;
  readonly exercises: string;
  readonly apply: Transform | null;
  /** Expected diff shape at data scope. */
  readonly expect:
    | { readonly kind: 'base' }
    | { readonly kind: 'unchanged' }
    | { readonly kind: 'modified'; readonly count: number }
    | { readonly kind: 'deleted'; readonly count: number }
    | { readonly kind: 'reguid-noop' };
}

const REVISIONS: readonly RevisionSpec[] = [
  { id: 'r00', changeClass: 'base', exercises: 'first commit, parents: []', apply: null, expect: { kind: 'base' } },
  { id: 'r01', changeClass: 'property-value-edit', exercises: 'change localises to one pset on one element', apply: editOwnPropertySet, expect: { kind: 'modified', count: 1 } },
  { id: 'r02', changeClass: 'element-moved', exercises: 'placement change with data unchanged', apply: moveElement, expect: { kind: 'unchanged' } },
  { id: 'r03', changeClass: 'element-renamed', exercises: 'attr:core only', apply: renameElement, expect: { kind: 'modified', count: 1 } },
  { id: 'r04', changeClass: 'element-deleted', exercises: 'deleted', apply: deleteElement, expect: { kind: 'deleted', count: 1 } },
  { id: 'r05', changeClass: 'type-object-property-edit', exercises: 'types tracked, not only occurrences (#8040)', apply: editTypeObjectPropertySet, expect: { kind: 'modified', count: 1 } },
  { id: 'r06', changeClass: 'property-set-shared', exercises: 'one definition, two consumers: the second wall swaps its own same-named set for the first wall\'s', apply: sharePropertySet, expect: { kind: 'modified', count: 1 } },
  { id: 'r07', changeClass: 'shared-property-set-edit', exercises: 'one node change, two element markers', apply: editSharedPropertySet, expect: { kind: 'modified', count: 2 } },
  { id: 'r08', changeClass: 'reexport-reguid', exercises: 'GUID-AGNOSTIC: total churn when keyed by GlobalId, unchanged under content matching', apply: reExportRegeneratingGuids, expect: { kind: 'reguid-noop' } },
  { id: 'r09', changeClass: 'byte-identical-resave', exercises: 'empty diff: must produce no commit', apply: byteIdenticalResave, expect: { kind: 'unchanged' } },
];

// ---------------------------------------------------------------------------
// Generate and verify.
// ---------------------------------------------------------------------------

async function fingerprintsOf(text: string) {
  const store = await new IfcParser().parseColumnar(
    new TextEncoder().encode(text).buffer as ArrayBuffer,
    { disableWorkerScan: true },
  );
  return buildFileFingerprints(store);
}

interface MeasuredDiff {
  readonly added: number;
  readonly modified: number;
  readonly deleted: number;
  readonly unchanged: number;
  readonly changedComponents: readonly string[];
  readonly modifiedKeys: readonly string[];
  readonly deletedKeys: readonly string[];
  /** Content-match claims, when the pass ran. `null` when it abstained. */
  readonly contentMatchKinds: Readonly<Record<string, number>> | null;
}

/**
 * Both readings of the same pair, because they answer different questions.
 *
 * `keyed` is the default: entities are paired by `GlobalId`. `contentMatched`
 * additionally runs the content pass, which pairs unmatched entities by their
 * data hash. The gap between the two IS the GUID-agnostic story — a
 * re-exported model is total churn under `keyed` and unchanged under
 * `contentMatched`, which is exactly why ifc-git treats `GlobalId` as evidence
 * rather than identity.
 */
interface MeasuredPair {
  readonly keyed: MeasuredDiff;
  readonly contentMatched: MeasuredDiff;
}

function summarize(diff: any): MeasuredDiff {
  const components = new Set<string>();
  const modifiedKeys: string[] = [];
  const deletedKeys: string[] = [];
  for (const entry of diff.entries) {
    if (entry.state === 'modified') {
      modifiedKeys.push(entry.key);
      for (const c of entry.changedComponents ?? []) components.add(c);
    } else if (entry.state === 'deleted') {
      deletedKeys.push(entry.key);
    }
  }
  let kinds: Record<string, number> | null = null;
  if (diff.contentMatches !== undefined) {
    kinds = {};
    for (const match of diff.contentMatches) {
      kinds[match.kind] = (kinds[match.kind] ?? 0) + 1;
    }
  }
  return {
    added: diff.counts.added,
    modified: diff.counts.modified,
    deleted: diff.counts.deleted,
    unchanged: diff.counts.unchanged,
    changedComponents: [...components].sort(),
    modifiedKeys: modifiedKeys.sort(),
    deletedKeys: deletedKeys.sort(),
    contentMatchKinds: kinds,
  };
}

async function measure(baseText: string, headText: string): Promise<MeasuredPair> {
  const [base, head] = await Promise.all([fingerprintsOf(baseText), fingerprintsOf(headText)]);
  return {
    keyed: summarize(diffModels(base, head, { scope: 'data' })),
    contentMatched: summarize(
      diffModels(base, head, { scope: 'data', matchUnpairedByContent: true }),
    ),
  };
}

function churn(d: MeasuredDiff): number {
  return d.added + d.modified + d.deleted;
}

/** Set equality, order- and duplicate-insensitive. */
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const x = [...new Set(a)].sort();
  const y = [...new Set(b)].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/**
 * Counts alone cannot tell "one element modified" from "the WRONG element
 * modified", so every revision whose change is visible at data scope also has
 * its declared `touched` GlobalIds and `expectComponents` compared against the
 * measurement. Without this, `checkExpectation` would pass a transform that
 * edited something else entirely as long as the arithmetic worked out.
 */
function checkClaims(applied: Applied, k: MeasuredDiff): string | null {
  if (!sameSet(k.modifiedKeys, applied.touched)) {
    return `declared touched [${applied.touched.join(' ')}], measured modified [${k.modifiedKeys.join(' ')}]`;
  }
  if (!sameSet(k.changedComponents, applied.expectComponents)) {
    return `declared components [${applied.expectComponents.join(' ')}], measured [${k.changedComponents.join(' ')}]`;
  }
  return null;
}

/**
 * Verify a {@link SharedDefinition} claim against the model the transform
 * actually produced — three independent ways, because each catches something
 * the others do not.
 *
 * 1. STRUCTURE. Exactly which elements reach that one definition record. A
 *    regression that un-shares the set by giving each element its own copy
 *    leaves `touched` and `expectComponents` intact and fails here.
 * 2. SCHEMA. Each consumer carries exactly ONE property set of that name —
 *    `IfcObject.UniquePropertySetNames`. This is the rule the original fixture
 *    broke.
 * 3. ENGINE. The `pset:<name>` sub-hash is PRESENT and IDENTICAL on every
 *    consumer. One definition cannot hash two ways. This is the check with
 *    teeth: under the duplicate-set fixture the two walls hashed differently
 *    at `pset:Pset_WallCommon` while the manifest still recorded the revision
 *    as a shared-set change.
 */
async function checkSharedDefinition(claim: SharedDefinition, text: string): Promise<string | null> {
  const index = indexLines(text.split('\n'));
  const rooted = rootedLines(index);
  const byGlobalId = new Map(rooted.map((l) => [globalIdOf(l)!, l]));

  const definition = byGlobalId.get(claim.definition);
  if (!definition || definition.type !== 'IFCPROPERTYSET') {
    return `declared definition ${claim.definition} is not an IfcPropertySet in the produced model`;
  }
  if (psetName(definition) !== claim.name) {
    return `definition ${claim.definition} is named '${psetName(definition)}', declared '${claim.name}'`;
  }

  const consumers: string[] = [];
  for (const rel of findByType(index, 'IFCRELDEFINESBYPROPERTIES')) {
    const args = splitArgs(rel.args);
    if (!refersTo(args[5] ?? '', definition.id)) continue;
    for (const ref of (args[4] ?? '').matchAll(/#(\d+)/g)) {
      const owner = index.get(Number(ref[1]));
      const gid = owner ? globalIdOf(owner) : null;
      if (gid !== null) consumers.push(gid);
    }
  }
  if (!sameSet(consumers, claim.consumers)) {
    return (
      `'${claim.name}' ${claim.definition} is referenced by [${[...new Set(consumers)].sort().join(' ')}], ` +
      `declared [${[...new Set(claim.consumers)].sort().join(' ')}]`
    );
  }

  for (const gid of claim.consumers) {
    const owner = byGlobalId.get(gid);
    if (!owner) return `declared consumer ${gid} is not in the produced model`;
    const sameName = psetAssociationsOf(index, owner.id).filter(
      (a) => psetName(a.pset) === claim.name,
    );
    if (sameName.length !== 1) {
      return (
        `${gid} carries ${sameName.length} property sets named '${claim.name}' ` +
        `(#${sameName.map((a) => a.pset.id).join(', #')}); ` +
        'IfcObject.UniquePropertySetNames allows exactly one'
      );
    }
  }

  const key = `pset:${claim.name}`;
  const fingerprints = await fingerprintsOf(text);
  const hashes = new Map<string, string | undefined>();
  for (const gid of claim.consumers) {
    const fp = fingerprints.find((f: { key: string }) => f.key === gid);
    if (!fp) return `consumer ${gid} is not a comparable entity, so its components cannot be read`;
    hashes.set(gid, fp.components?.[key]);
  }
  const absent = [...hashes].filter(([, h]) => h === undefined).map(([gid]) => gid);
  if (absent.length > 0) return `consumers [${absent.join(' ')}] carry no '${key}' component`;
  if (new Set(hashes.values()).size !== 1) {
    return (
      `'${key}' hashes differently across consumers ` +
      `(${[...hashes].map(([gid, h]) => `${gid}=${h!.slice(0, 12)}`).join(' ')}); ` +
      'the definition is not actually shared'
    );
  }
  return null;
}

function checkExpectation(
  spec: RevisionSpec,
  applied: Applied,
  m: MeasuredPair,
): string | null {
  const k = m.keyed;
  switch (spec.expect.kind) {
    case 'base':
      return null;
    case 'unchanged':
      return churn(k) === 0
        ? null
        : `expected no data-scope change, measured +${k.added} ~${k.modified} -${k.deleted}`;
    case 'modified':
      return k.modified === spec.expect.count && k.added === 0 && k.deleted === 0
        ? checkClaims(applied, k)
        : `expected exactly ${spec.expect.count} modified, measured +${k.added} ~${k.modified} -${k.deleted}`;
    case 'deleted':
      if (!(k.deleted === spec.expect.count && k.added === 0)) {
        return `expected ${spec.expect.count} deleted, measured +${k.added} ~${k.modified} -${k.deleted}`;
      }
      return sameSet(k.deletedKeys, applied.touched)
        ? null
        : `declared deletion of [${applied.touched.join(' ')}], measured [${k.deletedKeys.join(' ')}]`;
    case 'reguid-noop': {
      // The whole point of the corpus. A re-GUID must be total churn when
      // paired by GlobalId, and nothing at all once content matching runs.
      if (k.added === 0 || k.deleted === 0) {
        return `expected GlobalId-keyed churn from a re-GUID, measured +${k.added} ~${k.modified} -${k.deleted}`;
      }
      if (k.added !== k.deleted) {
        return `expected a balanced re-GUID, measured +${k.added} vs -${k.deleted}`;
      }
      const c = m.contentMatched;
      return churn(c) === 0
        ? null
        : `expected content matching to absorb the re-GUID, measured +${c.added} ~${c.modified} -${c.deleted}`;
    }
  }
}

const baseText = await readFile(BASE_FILE, 'utf8');
mkdirSync(OUT_DIR, { recursive: true });

const entries: unknown[] = [];
const failures: string[] = [];
let previousText = baseText;
let previousId: string | null = null;

for (const spec of REVISIONS) {
  const applied: Applied =
    spec.apply === null
      ? { text: baseText, touched: [], expectComponents: [] }
      : spec.apply(previousText);

  const file = `building-architecture-${spec.id}.ifc`;
  await writeFile(path.join(OUT_DIR, file), applied.text);

  const measured =
    previousId === null ? null : await measure(previousText, applied.text);
  if (measured) {
    const problem = checkExpectation(spec, applied, measured);
    if (problem) failures.push(`${spec.id} (${spec.changeClass}): ${problem}`);
  }
  // Independent of the diff: a revision whose point is a SHARED definition has
  // to be able to show the sharing in the model it produced, not just a
  // plausible set of counts and keys between two revisions.
  if (applied.shared) {
    const problem = await checkSharedDefinition(applied.shared, applied.text);
    if (problem) failures.push(`${spec.id} (${spec.changeClass}): ${problem}`);
  }

  entries.push({
    id: spec.id,
    file,
    parent: previousId,
    changeClass: spec.changeClass,
    exercises: spec.exercises,
    sha256: sha256(applied.text),
    bytes: Buffer.byteLength(applied.text, 'utf8'),
    identicalToParentBytes: previousId !== null && applied.text === previousText,
    touchedGlobalIds: applied.touched,
    sharedDefinition: applied.shared ?? null,
    geometryScopeRequired: spec.changeClass === 'element-moved',
    note: applied.note ?? null,
    measuredDataDiff: measured,
  });

  previousText = applied.text;
  previousId = spec.id;
}

const manifest = {
  '//': 'GENERATED by tools/ifc-git-corpus/derive-revisions.mts - do not hand-edit.',
  version: 1,
  issue: 8128,
  base: 'apps/viewer/public/samples/building-architecture.ifc',
  baseSha256: sha256(baseText),
  verificationScope: 'data',
  verificationNote:
    'Measured with @ifc-lite/diff at scope "data", which needs no geometry pipeline and so no WASM. Revisions flagged geometryScopeRequired carry a real change that data scope cannot see.',
  revisions: entries,
};

const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
const manifestPath = path.relative(REPO_ROOT, MANIFEST_FILE);

console.log(`wrote ${REVISIONS.length} revisions to ${path.relative(REPO_ROOT, OUT_DIR)}`);
for (const e of entries as Array<Record<string, any>>) {
  const m = e.measuredDataDiff as MeasuredPair | null;
  const fmt = (d: MeasuredDiff) => `+${d.added} ~${d.modified} -${d.deleted}`;
  const shape = m ? `${fmt(m.keyed).padEnd(13)} content:${fmt(m.contentMatched)}` : 'base';
  console.log(`  ${e.id}  ${String(e.changeClass).padEnd(26)} ${shape.padEnd(34)} ${(m?.keyed.changedComponents ?? []).join(',')}`);
}

// The manifest is written only AFTER the declarations hold. A failing run that
// wrote first would leave the contradicting measurements on disk, one `git add`
// away from being committed as the new expectation.
if (failures.length > 0) {
  console.error(`\n${failures.length} revision(s) did not match their declared change class:`);
  for (const f of failures) console.error(`  - ${f}`);
  console.error(`\n${manifestPath} left untouched.`);
  process.exit(1);
}

if (CHECK_ONLY) {
  const committed = await readFile(MANIFEST_FILE, 'utf8').catch(() => null);
  if (committed !== serialized) {
    console.error(
      `\n${manifestPath} does not match a fresh derivation` +
        `${committed === null ? ' (missing)' : ''}.` +
        '\nRe-run without --check and commit the result.',
    );
    process.exit(1);
  }
  console.log(`\nevery revision matched its declared change class; ${manifestPath} is current`);
} else {
  await writeFile(MANIFEST_FILE, serialized);
  console.log(`wrote manifest ${manifestPath}`);
  console.log('\nevery revision matched its declared change class');
}
