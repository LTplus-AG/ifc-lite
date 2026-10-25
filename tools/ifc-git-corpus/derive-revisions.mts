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
 * between consecutive revisions and recording the measured result. A revision
 * whose measured diff contradicts its declared change class fails the run, so
 * the manifest cannot drift from what the bytes actually do.
 *
 * Verification scope is `data`, deliberately: it needs no geometry pipeline and
 * therefore no WASM, so this runs on any checkout. Revisions whose change is
 * geometric are marked `geometryScopeRequired` in the manifest — their bytes
 * are correct, but proving the change needs the geometry lane.
 *
 * Run from the repo root:
 *   pnpm build   # or at least packages/{parser,diff,cli,encoding}
 *   pnpm tsx tools/ifc-git-corpus/derive-revisions.mts
 *
 * Deliberately not run in CI: it WRITES the manifest the tests then check.
 * Regenerating in CI would let a drifting engine rewrite its own expectations.
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

const REQUIRED_DIST = [
  'packages/parser/dist/index.js',
  'packages/diff/dist/index.js',
  'packages/encoding/dist/index.js',
  'packages/cli/dist/commands/diff-engine.js',
];
const missing = REQUIRED_DIST.filter((p) => !existsSync(path.join(REPO_ROOT, p)));
if (missing.length > 0) {
  console.error(
    `Missing built output:\n  ${missing.join('\n  ')}\n\nRun \`pnpm build\` first.`,
  );
  process.exit(1);
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

// ---------------------------------------------------------------------------
// Revision transforms. Each takes the previous revision's text and returns the
// next, plus the facts the manifest records.
// ---------------------------------------------------------------------------

interface Applied {
  readonly text: string;
  /** GlobalIds the change is expected to touch. Empty for a no-op revision. */
  readonly touched: readonly string[];
  /** Component keys the change is expected to move, where data-scope can see them. */
  readonly expectComponents: readonly string[];
  readonly note?: string;
}

type Transform = (text: string) => Applied;

/** The wall whose own property set is edited, and the type whose set is edited. */
function pickWall(index: Map<number, StepLine>): StepLine {
  return requireOne(findByType(index, 'IFCWALL'), 'IfcWall');
}

/** Find the property set attached to `ownerId` through IfcRelDefinesByProperties. */
function psetOf(index: Map<number, StepLine>, ownerId: number): StepLine {
  for (const rel of findByType(index, 'IFCRELDEFINESBYPROPERTIES')) {
    const args = splitArgs(rel.args);
    const related = args[4] ?? '';
    if (!related.includes(`#${ownerId}`)) continue;
    const psetRef = /#(\d+)/.exec(args[5] ?? '');
    if (!psetRef) continue;
    const pset = index.get(Number(psetRef[1]));
    if (pset && pset.type === 'IFCPROPERTYSET') return pset;
  }
  throw new Error(`no IfcPropertySet reachable from #${ownerId}`);
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

const moveElement: Transform = (text) => {
  const lines = text.split('\n');
  const index = indexLines(lines);
  const wall = pickWall(index);
  const point = requireOne(findByType(index, 'IFCCARTESIANPOINT'), 'IfcCartesianPoint');
  const coords = splitArgs(splitArgs(point.args)[0].replace(/^\(|\)$/g, ''));
  const shifted = `(${[Number(coords[0]) + 250, coords[1], coords[2]].join(',')})`;
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

const sharePropertySet: Transform = (text) => {
  const lines = text.split('\n');
  const index = indexLines(lines);
  const walls = findByType(index, 'IFCWALL');
  if (walls.length < 2) throw new Error('need two IfcWalls to share a property set');
  const [first, second] = walls;
  for (const rel of findByType(index, 'IFCRELDEFINESBYPROPERTIES')) {
    const args = splitArgs(rel.args);
    if (!(args[4] ?? '').includes(`#${first.id}`)) continue;
    if ((args[4] ?? '').includes(`#${second.id}`)) continue;
    args[4] = (args[4] ?? '').replace(/\)$/, `,#${second.id})`);
    rewriteRecord(lines, rel, args);
    return {
      text: lines.join('\n'),
      touched: [globalIdOf(second)!],
      // The second wall gains the set; the first is untouched.
      expectComponents: [],
      note: 'the second wall gains a property set it did not carry',
    };
  }
  throw new Error('no IfcRelDefinesByProperties found for the first wall');
};

const editSharedPropertySet: Transform = (text) => {
  const lines = text.split('\n');
  const index = indexLines(lines);
  const walls = findByType(index, 'IFCWALL');
  const shared = psetOf(index, walls[0].id);
  const prop = firstProperty(index, shared);
  rewriteRecord(lines, prop, bumpPropertyValue(splitArgs(prop.args)));
  return {
    text: lines.join('\n'),
    touched: walls.slice(0, 2).map((w) => globalIdOf(w)!),
    expectComponents: [`pset:${psetName(shared)}`],
    note: 'one node change, two element markers -- the localisation payoff',
  };
};

const deleteElement: Transform = (text) => {
  const lines = text.split('\n');
  const index = indexLines(lines);
  const furniture = findByType(index, 'IFCFURNITURE');
  const victim = requireOne(furniture.length > 0 ? furniture : findByType(index, 'IFCWALL'), 'deletable element');
  const gid = globalIdOf(victim)!;
  const kept = lines.filter((_, i) => i !== victim.index);
  const scrubbed = kept.map((line) =>
    line
      .replace(new RegExp(`#${victim.id}(?![0-9]),`, 'g'), '')
      .replace(new RegExp(`,#${victim.id}(?![0-9])`, 'g'), '')
      .replace(new RegExp(`\\(#${victim.id}(?![0-9])\\)`, 'g'), '()'),
  );
  return { text: scrubbed.join('\n'), touched: [gid], expectComponents: [] };
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
    | { readonly kind: 'any' }
    | { readonly kind: 'reguid-noop' };
}

const REVISIONS: readonly RevisionSpec[] = [
  { id: 'r00', changeClass: 'base', exercises: 'first commit, parents: []', apply: null, expect: { kind: 'base' } },
  { id: 'r01', changeClass: 'property-value-edit', exercises: 'change localises to one pset on one element', apply: editOwnPropertySet, expect: { kind: 'modified', count: 1 } },
  { id: 'r02', changeClass: 'element-moved', exercises: 'placement change with data unchanged', apply: moveElement, expect: { kind: 'unchanged' } },
  { id: 'r03', changeClass: 'element-renamed', exercises: 'attr:core only', apply: renameElement, expect: { kind: 'modified', count: 1 } },
  { id: 'r04', changeClass: 'element-deleted', exercises: 'deleted', apply: deleteElement, expect: { kind: 'deleted', count: 1 } },
  { id: 'r05', changeClass: 'type-object-property-edit', exercises: 'types tracked, not only occurrences (#8040)', apply: editTypeObjectPropertySet, expect: { kind: 'modified', count: 1 } },
  { id: 'r06', changeClass: 'property-set-shared', exercises: 'a relationship gains a second related object', apply: sharePropertySet, expect: { kind: 'any' } },
  { id: 'r07', changeClass: 'shared-property-set-edit', exercises: 'one node change, N element markers', apply: editSharedPropertySet, expect: { kind: 'any' } },
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
  for (const entry of diff.entries) {
    if (entry.state === 'modified') {
      modifiedKeys.push(entry.key);
      for (const c of entry.changedComponents ?? []) components.add(c);
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

function checkExpectation(spec: RevisionSpec, m: MeasuredPair): string | null {
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
        ? null
        : `expected exactly ${spec.expect.count} modified, measured +${k.added} ~${k.modified} -${k.deleted}`;
    case 'deleted':
      return k.deleted === spec.expect.count && k.added === 0
        ? null
        : `expected ${spec.expect.count} deleted, measured +${k.added} ~${k.modified} -${k.deleted}`;
    case 'any':
      return churn(k) > 0 ? null : 'expected some change, measured none';
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
    const problem = checkExpectation(spec, measured);
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

await writeFile(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`wrote ${REVISIONS.length} revisions to ${path.relative(REPO_ROOT, OUT_DIR)}`);
console.log(`wrote manifest ${path.relative(REPO_ROOT, MANIFEST_FILE)}`);
for (const e of entries as Array<Record<string, any>>) {
  const m = e.measuredDataDiff as MeasuredPair | null;
  const fmt = (d: MeasuredDiff) => `+${d.added} ~${d.modified} -${d.deleted}`;
  const shape = m ? `${fmt(m.keyed).padEnd(13)} content:${fmt(m.contentMatched)}` : 'base';
  console.log(`  ${e.id}  ${String(e.changeClass).padEnd(26)} ${shape.padEnd(34)} ${(m?.keyed.changedComponents ?? []).join(',')}`);
}

if (failures.length > 0) {
  console.error(`\n${failures.length} revision(s) did not match their declared change class:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\nevery revision matched its declared change class');
