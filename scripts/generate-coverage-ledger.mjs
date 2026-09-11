#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Generate `docs/architecture/coverage-ledger.md`: one row per concrete IFC
 * entity, per schema version, with a status derived from the real artifact
 * that decides it — never a hand-typed opinion (#4207).
 *
 * The only coverage table that existed before this generator was three
 * hand-written rows in `docs/guide/parsing.md` ("Supported" / "Full
 * Support"), and `docs/architecture/geometry-pipeline.md` listed six
 * geometry representation types by hand while the router's processor
 * registry (`rust/geometry/src/router/processor_registry.rs`) currently
 * covers 23 distinct `IfcType` variants across 18 processor structs — a
 * hand-written table that was already wrong the day it was written, exactly
 * the failure AGENTS.md documents for the CI gate list. This generator
 * replaces both tables with one derived from source, and is itself checked
 * by `scripts/check-generated.mjs` so it cannot go stale silently again.
 *
 * DERIVATION, per column (the real artifact each reads, not a parallel list):
 *
 *   registry      — the entity's name appears in the generated buildingSMART
 *                    table for that schema version
 *                    (`packages/data/src/ifc-schema/generated/entities-*.ts`,
 *                    `ENTITIES_IFC*`), with `abstract: false` (only concrete
 *                    entities can appear in a STEP file). Uses the SAME
 *                    `parseEntityTable` parser `check-legacy-entity-coverage.mjs`
 *                    already ships and is tested against, not a re-derived copy.
 *   retained      — the entity's uppercase name resolves to a real `IfcType`
 *                    variant rather than `Unknown`: directly, via
 *                    `rust/core/src/generated/schema.rs`'s `from_str` arms
 *                    (`generatedNames`, same parser as above), for IFC4X3; or
 *                    via a `rust/core/src/legacy_entities.rs` match arm
 *                    (`legacyKeys`, same parser) for IFC2X3/IFC4, since that is
 *                    the table `rust/core/src/schema_helpers.rs` says every
 *                    classification pass must consult instead of a bare
 *                    `IfcType::from_str`.
 *   relationships — the entity's name is one of the 17 `IfcRel*` classes
 *                    `packages/data/src/relationship-graph.ts`'s
 *                    `RelationshipTypeToString` maps a `RelationshipType` enum
 *                    member to. Only meaningful for `IfcRel*` rows; every
 *                    other row is `—` (not a relationship entity, not a gap).
 *   geometry      — the entity's `IfcType` appears in the `TYPES` const array
 *                    in `rust/geometry/src/router/processor_registry.rs`,
 *                    the actual slot table the router dispatches through
 *                    (not each processor's own `supported_types()`, which is
 *                    an internal replacement-tracking detail called only
 *                    after a processor is already selected by this table).
 *   creatable     — the entity's PascalCase name is emitted, literally, by
 *                    either `IfcCreator.addIfc*()` (`this.line(id, 'IFCXXX', ...)`
 *                    in `packages/create/src/ifc-creator.ts`) or an in-store
 *                    builder (`editor.addEntity('IfcXxx', ...)` under
 *                    `packages/create/src/in-store/*.ts`).
 *   convertible   — for IFC2X3<->IFC4 and IFC4<->IFC4X3 (IFC4X3<->IFC2X3 is
 *                    not attempted directly — no single hop exists), the
 *                    entity converts to a name that is ALSO a registry entry
 *                    in the target schema. Uses the same rename maps
 *                    `packages/export/src/schema-converter.ts` exports
 *                    (`convertEntityType`'s own `IFC2X3_TO_IFC4` /
 *                    `IFC4_TO_IFC2X3` / `IFC4_TO_IFC4X3` / `IFC4X3_TO_IFC4`
 *                    Maps), parsed from that file's source rather than a
 *                    restated copy.
 *   writable      — the entity's uppercase STEP keyword appears in a
 *                    dedicated `this.line(id, 'IFCXXX', ...)` call inside
 *                    `packages/create/src/ifc-creator.ts` — `IfcCreator`'s
 *                    own STEP-line-emission primitive, captured BEFORE the
 *                    in-store merge below folds in the broader `creatable`
 *                    set. Narrower than `creatable` on purpose: `creatable`
 *                    also counts entities reachable only through the
 *                    generic in-store `editor.addEntity()` overlay escape
 *                    hatch, which stages a mutation rather than writing a
 *                    STEP line itself.
 *   fixture       — a committed `.ifc` sample, DECLARING THIS ROW'S OWN
 *                    SCHEMA in its own `FILE_SCHEMA` header, carries a STEP
 *                    record of this class. Scanned across the repo's own
 *                    fixture corpus (`FIXTURE_DIRS` below), then partitioned
 *                    per schema by that header before matching — a fixture
 *                    is only ever cited under the schema it actually
 *                    declares, never pooled across schemas or used to
 *                    stand in for a different one (#4474). A file whose
 *                    header is missing, unparseable, or names a schema this
 *                    ledger has no section for (e.g. `IFC4X2`) is skipped
 *                    outright, not defaulted into any section.
 *                    This is a regex over committed files, not a parser
 *                    run: it does not invoke the TypeScript/Rust loader and
 *                    is a materially different signal from #4208's drop
 *                    census (`packages/parser/src/drop-census.ts`), which is
 *                    per-model and resolves schema through the actual
 *                    parser. Loosely related, not the same measurement.
 *
 * VACUITY GUARD: every extractor below throws if it returns an empty set —
 * a parser broken by a refactor must fail loudly, not silently emit a ledger
 * that reports "0 processors" as if that were the true count. See
 * `assertNonEmpty`.
 *
 * Usage:
 *   node scripts/generate-coverage-ledger.mjs            # regenerate + write
 *   node scripts/generate-coverage-ledger.mjs --check     # CI: fail if stale
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { legacyKeys, generatedNames, parseEntityTable } from './check-legacy-entity-coverage.mjs';

const rootFlag = process.argv.indexOf('--root');
const ROOT =
  rootFlag !== -1 && process.argv[rootFlag + 1]
    ? process.argv[rootFlag + 1]
    : join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');
const OUT_REL = 'docs/architecture/coverage-ledger.md';

function read(rel) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) throw new Error(`coverage-ledger: missing source file ${rel}`);
  return readFileSync(p, 'utf8');
}

function assertNonEmpty(name, collection) {
  const size = collection instanceof Map || collection instanceof Set ? collection.size : collection.length;
  if (size === 0) {
    throw new Error(
      `coverage-ledger: extractor "${name}" found ZERO entries — this almost certainly means the ` +
        `source file it parses was refactored and the extractor's pattern no longer matches, not ` +
        `that the real count is zero. Refusing to emit a vacuous ledger. Fix the extractor.`,
    );
  }
}

// ─── Schema versions ─────────────────────────────────────────────────────

const SCHEMAS = ['IFC2X3', 'IFC4', 'IFC4X3'];
const ENTITY_FILE = {
  IFC2X3: 'packages/data/src/ifc-schema/generated/entities-ifc2x3.ts',
  IFC4: 'packages/data/src/ifc-schema/generated/entities-ifc4.ts',
  IFC4X3: 'packages/data/src/ifc-schema/generated/entities-ifc4x3.ts',
};

const registryTables = new Map(); // schema -> Map<name, {isAbstract}>
for (const schema of SCHEMAS) {
  const table = parseEntityTable(read(ENTITY_FILE[schema]));
  assertNonEmpty(`registry(${schema})`, table);
  registryTables.set(schema, table);
}

// ─── Retained (resolves to a real IfcType, not Unknown) ─────────────────

const schemaRs = read('rust/core/src/generated/schema.rs');
const legacyRs = read('rust/core/src/legacy_entities.rs');
const ifc4x3RetainedNames = new Set([...generatedNames(schemaRs)].map((n) => n.toUpperCase()));
assertNonEmpty('retained(IFC4X3 from_str arms)', ifc4x3RetainedNames);
const legacyRetainedNames = new Set([...legacyKeys(legacyRs)].map((n) => n.toUpperCase()));
assertNonEmpty('retained(legacy_entities.rs arms)', legacyRetainedNames);

function isRetained(schema, upperName) {
  if (ifc4x3RetainedNames.has(upperName)) return true;
  if (schema !== 'IFC4X3' && legacyRetainedNames.has(upperName)) return true;
  return false;
}

// ─── Relationships (RelationshipType -> IfcRel* class) ──────────────────

const relGraphSrc = read('packages/data/src/relationship-graph.ts');
function extractRelationshipClasses(src) {
  const start = src.indexOf('function RelationshipTypeToString');
  if (start === -1) throw new Error('coverage-ledger: RelationshipTypeToString not found in relationship-graph.ts');
  const namesStart = src.indexOf('const names:', start);
  const close = src.indexOf('};', namesStart);
  if (namesStart === -1 || close === -1) {
    throw new Error('coverage-ledger: could not bound the `names` map in RelationshipTypeToString');
  }
  const body = src.slice(namesStart, close);
  return new Set([...body.matchAll(/:\s*'(IfcRel[A-Za-z0-9]+)'/g)].map((m) => m[1]));
}
const relationshipClasses = extractRelationshipClasses(relGraphSrc);
assertNonEmpty('relationships(RelationshipTypeToString)', relationshipClasses);
const relationshipClassesUpper = new Set([...relationshipClasses].map((n) => n.toUpperCase()));

// ─── Geometry (router processor_registry.rs TYPES table) ────────────────

const processorRegistrySrc = read('rust/geometry/src/router/processor_registry.rs');
function extractGeometryTypes(src) {
  const start = src.indexOf('const TYPES');
  if (start === -1) throw new Error('coverage-ledger: `const TYPES` not found in processor_registry.rs');
  const open = src.indexOf('[', src.indexOf('=', start));
  const close = src.indexOf('];', open);
  if (open === -1 || close === -1) throw new Error('coverage-ledger: could not bound the TYPES array');
  const body = src.slice(open, close);
  return new Set([...body.matchAll(/IfcType::(\w+)/g)].map((m) => m[1].toUpperCase()));
}
const geometryTypes = extractGeometryTypes(processorRegistrySrc);
assertNonEmpty('geometry(processor_registry TYPES)', geometryTypes);

// ─── Creatable (IfcCreator.addIfc* + in-store editor.addEntity) ─────────

const creatorSrc = read('packages/create/src/ifc-creator.ts');
function extractCreatorTypes(src) {
  return new Set([...src.matchAll(/this\.line\([^,]+,\s*'([A-Z0-9]+)'/g)].map((m) => m[1].toUpperCase()));
}
const creatorTypes = extractCreatorTypes(creatorSrc);
assertNonEmpty('creatable(IfcCreator.this.line)', creatorTypes);
// "writable" (#4207): IfcCreator's OWN this.line() STEP-emission set, frozen
// here BEFORE the in-store merge below widens `creatorTypes` into the
// broader `creatable` set. See the DERIVATION comment at the top of this
// file for why the two differ.
const writableTypes = new Set(creatorTypes);

// Every non-test TypeScript source under the in-store builder directory is
// scanned — enumerated from the directory, not from a hand-kept list. A list
// silently drifts: `_emit-helpers.ts` (which emits IfcColourRgb,
// IfcSurfaceStyle, IfcSurfaceStyleShading, ...) was missing from the first
// version of this generator, so those rows read "not creatable" while
// `--check` stayed green. A directory walk cannot miss a new builder.
const IN_STORE_DIR = join(ROOT, 'packages/create/src/in-store');
const inStoreFiles = existsSync(IN_STORE_DIR)
  ? readdirSync(IN_STORE_DIR)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts'))
      .sort()
  : [];
const inStoreTypes = new Set();
for (const f of inStoreFiles) {
  const src = readFileSync(join(IN_STORE_DIR, f), 'utf8');
  for (const m of src.matchAll(/editor\.addEntity\('(Ifc[A-Za-z0-9]+)'/g)) {
    creatorTypes.add(m[1].toUpperCase());
    inStoreTypes.add(m[1].toUpperCase());
  }
}
assertNonEmpty('creatable(in-store editor.addEntity)', inStoreTypes);

// ─── Convertible (schema-converter.ts rename maps, direct hops only) ────

const converterSrc = read('packages/export/src/schema-converter.ts');
function extractRenameMap(src, constName) {
  const start = src.indexOf(`const ${constName}`);
  if (start === -1) throw new Error(`coverage-ledger: const ${constName} not found in schema-converter.ts`);
  const open = src.indexOf('[', src.indexOf('=', start));
  const close = src.indexOf(']);', open);
  if (open === -1 || close === -1) throw new Error(`coverage-ledger: could not bound ${constName}`);
  const body = src.slice(open, close);
  const map = new Map();
  for (const m of body.matchAll(/\['(IFC[A-Z0-9]+)',\s*'(IFC[A-Z0-9]+)'\]/g)) {
    map.set(m[1], m[2]);
  }
  return map;
}
const RENAME = {
  'IFC2X3->IFC4': extractRenameMap(converterSrc, 'IFC2X3_TO_IFC4'),
  'IFC4->IFC2X3': extractRenameMap(converterSrc, 'IFC4_TO_IFC2X3'),
  'IFC4->IFC4X3': extractRenameMap(converterSrc, 'IFC4_TO_IFC4X3'),
  'IFC4X3->IFC4': extractRenameMap(converterSrc, 'IFC4X3_TO_IFC4'),
};
// IFC4_TO_IFC4X3 is legitimately near-empty in source today (most names are
// unchanged going forward) — don't vacuity-guard maps whose true size is 0..N;
// only the direct hops with substantial curation are guarded.
assertNonEmpty('convertible(IFC2X3_TO_IFC4)', RENAME['IFC2X3->IFC4']);
assertNonEmpty('convertible(IFC4_TO_IFC2X3)', RENAME['IFC4->IFC2X3']);
assertNonEmpty('convertible(IFC4X3_TO_IFC4)', RENAME['IFC4X3->IFC4']);

// ─── Fixture (committed .ifc corpus, per #4208 — see DERIVATION above) ──

// Fixed set of DIRECTORIES (not entity types — same pattern as
// `inStoreFiles` above) holding committed `.ifc` samples. Self-updating:
// a file added under one of these is picked up on the next generate without
// touching this list. A directory going missing isn't a parse failure (the
// catalogue drifts, same rationale as `inStoreFiles`); the vacuity guard
// below still requires the CORPUS as a whole to be non-empty.
const FIXTURE_DIRS = [
  'apps/landing/samples',
  'apps/viewer/public/samples',
  'packages/cli/examples/delivery',
  'rust/geometry/tests/fixtures',
  'rust/processing/tests/fixtures',
];

function walkIfcFiles(absDir) {
  const out = [];
  if (!existsSync(absDir)) return out;
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    const abs = join(absDir, entry.name);
    if (entry.isDirectory()) out.push(...walkIfcFiles(abs));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.ifc')) out.push(abs);
  }
  return out;
}

// Fixture attribution MUST be scoped to the fixture file's own declared
// schema (its HEADER's FILE_SCHEMA), never pooled across schemas — a fixture
// is only evidence for the schema it actually declares (#4474 review
// finding: a global map let an IFC4 sample get cited as IFC2X3 evidence).
//
// `IFC4X3_ADD2` / `IFC4X3_RC1..4` etc. all collapse onto the ledger's own
// `IFC4X3` section key (the ledger doesn't track AddendumX/RC granularity
// anywhere else either). Anything else — a header naming a schema this
// ledger has no section for (e.g. `IFC4X2`), or a file with no parseable
// FILE_SCHEMA header at all — is skipped outright: it is NEVER attributed to
// any section, not bucketed into a default/"unknown" section that could
// still leak into a row.
const FILE_SCHEMA_RE = /FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/;

function normalizeFixtureSchema(headerName) {
  const upper = headerName.toUpperCase();
  if (upper === 'IFC2X3') return 'IFC2X3';
  if (upper === 'IFC4') return 'IFC4';
  if (/^IFC4X3(_ADD\d+|_RC\d+)?$/.test(upper)) return 'IFC4X3';
  return null; // not one of this ledger's SCHEMAS — never attributed
}

// schema -> Map<UPPER STEP keyword, path (relative to ROOT) of the first
// fixture IN THAT SCHEMA, in sorted-path order, whose STEP records include
// that class>. First-found only (the ledger names ONE example per schema,
// not every fixture that qualifies).
const fixtureTypeToPathBySchema = new Map(SCHEMAS.map((s) => [s, new Map()]));
let fixtureFilesSkippedNoHeader = 0;
let fixtureFilesSkippedUnknownSchema = 0;
{
  const files = [];
  for (const dir of FIXTURE_DIRS) files.push(...walkIfcFiles(join(ROOT, dir)));
  files.sort();
  const recordRe = /^#\d+\s*=\s*([A-Z][A-Z0-9]*)\s*\(/gm;
  for (const abs of files) {
    // Repo-relative with forward slashes on every host: the ledger is a
    // committed artifact, and a Windows checkout must regenerate it
    // byte-identically to CI's Linux runner.
    const rel = abs.slice(ROOT.length + 1).split('\\').join('/');
    const text = readFileSync(abs, 'utf8');
    const headerMatch = text.match(FILE_SCHEMA_RE);
    if (!headerMatch) {
      fixtureFilesSkippedNoHeader++;
      continue; // no parseable FILE_SCHEMA header — never attributed to any section
    }
    const schema = normalizeFixtureSchema(headerMatch[1]);
    if (!schema) {
      fixtureFilesSkippedUnknownSchema++;
      continue; // header names a schema this ledger has no section for — never attributed
    }
    const map = fixtureTypeToPathBySchema.get(schema);
    for (const m of text.matchAll(recordRe)) {
      const type = m[1];
      if (!map.has(type)) map.set(type, rel);
    }
  }
}
assertNonEmpty(
  'fixture(committed .ifc corpus, any schema)',
  new Set([...fixtureTypeToPathBySchema.values()].flatMap((m) => [...m.keys()])),
);

// registry tables key by PascalCase entity name (from parseEntityTable), but
// every extractor above works in UPPERCASE STEP keywords. Build an
// upper->pascal index per schema once, so `convertible` can check target-schema
// membership by UPPER key without re-scanning the table per row.
const upperToPascal = new Map(); // schema -> Map<UPPER, Pascal>
for (const schema of SCHEMAS) {
  const idx = new Map();
  for (const name of registryTables.get(schema).keys()) idx.set(name.toUpperCase(), name);
  upperToPascal.set(schema, idx);
}

function statusIcon(ok) {
  return ok ? '✅' : '❌';
}

// ─── Build rows ────────────────────────────────────────────────────────

const DIRECT_HOPS = ['IFC2X3->IFC4', 'IFC4->IFC2X3', 'IFC4->IFC4X3', 'IFC4X3->IFC4'];

function buildSection(schema) {
  const table = registryTables.get(schema);
  const rows = [];
  for (const [name, info] of table) {
    if (info.isAbstract) continue; // no file instantiates an abstract entity
    const upper = name.toUpperCase();
    const retained = isRetained(schema, upper);
    const isRel = upper.startsWith('IFCREL');
    const relStatus = isRel ? (relationshipClassesUpper.has(upper) ? '✅' : '❌') : '—';
    const geometry = geometryTypes.has(upper) ? '✅' : '❌';
    const creatable = creatorTypes.has(upper) ? '✅' : '❌';
    const writable = writableTypes.has(upper) ? '✅' : '❌';
    const fixture = fixtureTypeToPathBySchema.get(schema).get(upper) ?? '—';
    const convertParts = [];
    for (const hop of DIRECT_HOPS) {
      const [from] = hop.split('->');
      if (from !== schema) continue;
      const to = hop.split('->')[1];
      const map = RENAME[hop];
      const targetUpper = map.get(upper) ?? upper;
      const targetIdx = upperToPascal.get(to);
      const ok = targetIdx.has(targetUpper);
      convertParts.push(`${to}:${ok ? '✅' : '❌'}`);
    }
    rows.push({
      name,
      registry: '✅',
      retained: statusIcon(retained),
      relationships: relStatus,
      geometry,
      creatable,
      writable,
      fixture,
      convertible: convertParts.join(' '),
    });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return rows;
}

const sections = new Map(SCHEMAS.map((s) => [s, buildSection(s)]));

// ─── Render markdown ──────────────────────────────────────────────────

function render() {
  const lines = [];
  lines.push('# Coverage ledger');
  lines.push('');
  lines.push(
    '<!-- GENERATED by scripts/generate-coverage-ledger.mjs — do not edit by hand. ' +
      'Regenerate with `node scripts/generate-coverage-ledger.mjs`; checked by `pnpm check:generated`. -->',
  );
  lines.push('');
  lines.push(
    'One row per concrete IFC entity ifc-lite\'s generated schema tables know about, per schema ' +
      'version, with a status derived from the artifact that actually decides it (see ' +
      '`scripts/generate-coverage-ledger.mjs` for exactly which file backs each column). Replaces ' +
      'the hand-written "Schema Support" table in `docs/guide/parsing.md` and the hand-written ' +
      '"Coverage by Type" table in `docs/architecture/geometry-pipeline.md`.',
  );
  lines.push('');
  lines.push(
    '**This ledger is expected to be mostly red — that is the measurement, not a bug list.** ' +
      'A ❌ means the artifact backing that column does not currently name this entity; it does not ' +
      'mean the entity is broken, and no red row here should be "fixed" as a side effect of a PR ' +
      'that touches this file.',
  );
  lines.push('');
  lines.push('Columns:');
  lines.push('');
  lines.push('- **registry** — the schema version recognizes this entity at all (always ✅ here; the row exists because it does).');
  lines.push('- **retained** — parsing resolves the name to a real internal type rather than dropping it as `Unknown`.');
  lines.push('- **relationships** — for `IfcRel*` entities only: the relationship graph builder models this relationship class. `—` for non-relationship entities.');
  lines.push('- **geometry** — the geometry router has a processor registered for this type. Scoped to *representation items* the router dispatches on directly (e.g. `IfcExtrudedAreaSolid`), not every product that eventually contains one — a wall\'s solid is `IfcExtrudedAreaSolid`, so `IfcWall` itself reads `❌` here while its representation item reads `✅`; that is the router\'s real dispatch surface, not a gap in this row.');
  lines.push('- **creatable** — `@ifc-lite/create` (`IfcCreator` or an in-store builder) can emit this entity.');
  lines.push('- **writable** — narrower than creatable: `IfcCreator` itself writes this entity via a dedicated `this.line()` STEP-emission call, rather than only through the generic in-store `editor.addEntity()` overlay escape hatch.');
  lines.push('- **convertible** — for each direct one-hop schema conversion FROM this row\'s version, whether the (possibly renamed) entity exists in the target schema\'s registry.');
  lines.push('- **fixture** — a committed `.ifc` sample in the repo\'s own fixture corpus, DECLARING THIS ROW\'S SCHEMA in its own `FILE_SCHEMA` header, that carries a STEP record of this class (path relative to repo root), or `—` if none of the scanned corpus directories do. A fixture is only ever cited under the schema it actually declares — never a cross-schema stand-in. This is a regex over the committed files (`#<n>=IFCXXX(...)`), not a parser run: unlike #4208\'s drop census (`packages/parser/src/drop-census.ts`), which is per-model and resolves schema through the real loader, this generator has no build step and cannot invoke it.');
  lines.push('');
  for (const schema of SCHEMAS) {
    const rows = sections.get(schema);
    lines.push(`## ${schema}`);
    lines.push('');
    lines.push(`${rows.length} concrete entities.`);
    lines.push('');
    lines.push('| Entity | Registry | Retained | Relationships | Geometry | Creatable | Writable | Convertible | Fixture |');
    lines.push('|---|---|---|---|---|---|---|---|---|');
    for (const r of rows) {
      lines.push(`| ${r.name} | ${r.registry} | ${r.retained} | ${r.relationships} | ${r.geometry} | ${r.creatable} | ${r.writable} | ${r.convertible} | ${r.fixture} |`);
    }
    lines.push('');
  }
  return lines.join('\n') + '\n';
}

const content = render();

// Per-schema fixture-resolve counts, printed on every run: after scoping
// `fixture` to each file's own declared schema, far fewer rows resolve a
// path than the old (buggy, cross-schema-pooled) count — that drop is
// expected. A schema with ZERO resolved rows would mean this generator
// found no committed fixture anywhere declaring that schema, which is a
// real, useful finding about the corpus and must be surfaced loudly rather
// than rendered silently as "every row is —".
for (const schema of SCHEMAS) {
  const rows = sections.get(schema);
  const resolved = rows.filter((r) => r.fixture !== '—').length;
  console.log(`  fixture(${schema}): ${resolved}/${rows.length} rows resolve a same-schema fixture`);
  if (resolved === 0) {
    console.warn(
      `⚠️  fixture(${schema}): ZERO rows resolve a fixture — no committed .ifc under FIXTURE_DIRS declares FILE_SCHEMA('${schema}...'). ` +
        'This is a true statement about the corpus, not a bug; every row in this schema will render "—" in the fixture column.',
    );
  }
}
if (fixtureFilesSkippedNoHeader > 0) {
  console.log(`  fixture: skipped ${fixtureFilesSkippedNoHeader} file(s) with no parseable FILE_SCHEMA header`);
}
if (fixtureFilesSkippedUnknownSchema > 0) {
  console.log(
    `  fixture: skipped ${fixtureFilesSkippedUnknownSchema} file(s) whose FILE_SCHEMA names a schema outside ${JSON.stringify(SCHEMAS)}`,
  );
}

if (CHECK) {
  const existing = existsSync(join(ROOT, OUT_REL)) ? readFileSync(join(ROOT, OUT_REL), 'utf8') : null;
  if (existing !== content) {
    console.error(`❌ ${OUT_REL} is stale.`);
    console.error('   fix: node scripts/generate-coverage-ledger.mjs   (then commit the file)');
    process.exit(1);
  }
  console.log(`✅ ${OUT_REL} is up to date.`);
} else {
  mkdirSync(dirname(join(ROOT, OUT_REL)), { recursive: true });
  writeFileSync(join(ROOT, OUT_REL), content);
  console.log(`Wrote ${OUT_REL} (${SCHEMAS.map((s) => `${s}: ${sections.get(s).length}`).join(', ')})`);
}
