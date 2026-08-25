#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Lint: `rust/core/src/legacy_entities.rs` must cover every concrete
 * `IfcProduct` subtype that the generated IFC4X3 enum cannot resolve, and must
 * not carry an arm whose key names no entity in any bundled schema.
 *
 * `rust/core/src/schema_helpers.rs` tells every classification pass to consult
 * that table "rather than a bare `IfcType::from_str`". Nothing checked that it
 * was complete. It held 21 arms, and six concrete, geometry-bearing IFC2X3
 * products were missing (#3172) — `IfcElectricalElement`,
 * `IfcElectricDistributionPoint`, `IfcChamferEdgeFeature`,
 * `IfcRoundedEdgeFeature`, `IfcStructuralLinearActionVarying`,
 * `IfcStructuralPlanarActionVarying`.
 *
 * The failure is SILENT, in both passes at once. A name the table misses
 * resolves to `IfcType::Unknown`, and `Unknown` is a subtype of nothing:
 * `rust/export/src/model.rs` keeps a row only if the type reaches `IfcProduct`,
 * and `has_geometry_by_name` refuses `Unknown` outright. So the entity is
 * dropped from the attribute export AND from meshing — the two passes agree,
 * on losing it. That is not the geometry/attribute divergence #1496 fixed;
 * nothing disagrees, so nothing looks wrong.
 *
 * `rust/export/src/merged.rs` states the method this gate mechanises: "Derived
 * by diffing `@ifc-lite/data`'s IFC2X3/IFC4/IFC4X3 entity tables against this
 * crate's IFC4X3-only schema ... Update by re-running that diff, not by ad hoc
 * inspection." A comment can only ask; this runs the diff.
 *
 * THE DEAD-KEY HALF is the other thing that went unnoticed for as long. The
 * table carried `"IFCELECTRICALDISTRIBUTIONPOINT"`, and no such IFC2X3 entity
 * exists — the real one has no "AL". The arm could never match a real file, and
 * a Rust test asserted `has_geometry_by_name` on the same misspelling, so the
 * table and its test certified each other while describing nothing.
 *
 * WHY A LINT AND NOT A TEST: this is a cross-language claim about two SOURCE
 * files, which is the shape `check-source-text-assertions.mjs` bans in test
 * files, for good reasons. Same call as
 * `check-clash-degenerate-reason-parity.mjs`.
 *
 * VACUITY GUARD: both extractors must come back non-empty, and the schema
 * tables must yield a plausible number of products. Two empty sets agree about
 * everything, so an extractor broken by a regenerated table would otherwise
 * turn this green by finding nothing.
 *
 * Run via `node scripts/check-legacy-entity-coverage.mjs` (CI node-test job).
 * `--root <dir>` points it at a mutated copy of the tree; that is how
 * `check-legacy-entity-coverage.test.mjs` proves it fires.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootFlag = process.argv.indexOf('--root');
const ROOT =
  rootFlag !== -1 && process.argv[rootFlag + 1]
    ? process.argv[rootFlag + 1]
    : join(dirname(fileURLToPath(import.meta.url)), '..');

const LEGACY_REL = 'rust/core/src/legacy_entities.rs';
const SCHEMA_REL = 'rust/core/src/generated/schema.rs';
const DATA_DIR = 'packages/data/src/ifc-schema/generated';
const OLD_SCHEMAS = ['entities-ifc2x3.ts', 'entities-ifc4.ts'];
const ALL_SCHEMAS = [...OLD_SCHEMAS, 'entities-ifc4x3.ts'];

/**
 * Keys the dead-key check exempts, with the reason each one is legitimately
 * absent from every bundled table.
 *
 * The bundled IFC4X3 table models strata as one concrete
 * `IfcGeotechnicalStratum` with a `PredefinedType` of SOLID / VOID / WATER,
 * while real infrastructure exporters emit the three leaf keywords (#860).
 * Those arms fire on real files; it is the TABLE that does not name them.
 * Every other arm must name something.
 */
const KEYS_ABSENT_FROM_EVERY_BUNDLED_TABLE = new Map([
  ['IFCSOLIDSTRATUM', 'IFC4X3 leaf the bundled table folds into IfcGeotechnicalStratum (#860)'],
  ['IFCVOIDSTRATUM', 'IFC4X3 leaf the bundled table folds into IfcGeotechnicalStratum (#860)'],
  ['IFCWATERSTRATUM', 'IFC4X3 leaf the bundled table folds into IfcGeotechnicalStratum (#860)'],
]);

/** Uppercase keys of every `"IFC…" => Some(LegacyEntityInfo {` arm. */
export function legacyKeys(rustSource) {
  return new Set([...rustSource.matchAll(/"(IFC[A-Z0-9]+)"\s*=>\s*Some\(/g)].map((m) => m[1]));
}

/**
 * The names in the `LEGACY_ENTITY_NAMES` const — the public mirror of the match
 * arms, and what `dump_rooted_type_sweep.rs` feeds into the cross-language
 * rooted-type universe (#3124).
 *
 * Bounded to the const's own `&[` … `];` block, so a name appearing only in a
 * doc comment or in a match arm elsewhere in the file cannot pad it.
 */
export function legacyNameConst(rustSource) {
  const start = rustSource.indexOf('pub const LEGACY_ENTITY_NAMES');
  if (start === -1) return new Set();
  const open = rustSource.indexOf('[', start);
  const close = rustSource.indexOf('];', open);
  if (open === -1 || close === -1) return new Set();
  return new Set([...rustSource.slice(open, close).matchAll(/"(IFC[A-Z0-9]+)"/g)].map((m) => m[1]));
}

/**
 * Uppercase names `IfcType::from_str` resolves to a real variant.
 *
 * Bounded to that ONE function rather than sliced to end of file: the arm shape
 * is generated, so a future `pub fn` emitting the same shape would silently
 * enlarge this set, and a name wrongly believed resolvable is a name this gate
 * stops demanding an arm for — the quiet direction.
 */
export function generatedNames(schemaSource) {
  const start = schemaSource.indexOf('pub fn from_str');
  if (start === -1) return new Set();
  const next = schemaSource.indexOf('pub fn ', start + 'pub fn from_str'.length);
  const body = schemaSource.slice(start, next === -1 ? undefined : next);
  return new Set([...body.matchAll(/^\s+"(IFC[A-Z0-9]+)" => Self::/gm)].map((m) => m[1]));
}

/**
 * `{ name, parent, abstract, attributes }` per row of a generated
 * `ENTITIES_*` table. The generator emits one row per line in a fixed shape,
 * so this is a line match rather than a TS parse.
 */
export function parseEntityTable(tsSource) {
  const out = new Map();
  const re =
    /\{ name: "([^"]+)", parent: (?:"([^"]+)"|undefined), abstract: (true|false), predefinedTypes: \[[^\]]*\], attributes: \[([^\]]*)\]/g;
  for (const m of tsSource.matchAll(re)) {
    out.set(m[1], {
      name: m[1],
      parent: m[2] ?? undefined,
      isAbstract: m[3] === 'true',
      attributes: m[4] ? m[4].split(',').map((s) => s.trim().replace(/^"|"$/g, '')) : [],
    });
  }
  return out;
}

/** Whether `name`'s parent chain within `table` reaches `ancestor`. */
function reaches(table, name, ancestor) {
  const seen = new Set();
  let cur = name;
  while (cur && table.has(cur) && !seen.has(cur)) {
    if (cur === ancestor) return true;
    seen.add(cur);
    cur = table.get(cur).parent;
  }
  return cur === ancestor;
}

/**
 * Concrete `IfcProduct` subtypes in an older schema — every entity a real file
 * can instantiate that both passes decide on by asking whether its type reaches
 * `IfcProduct`.
 *
 * Abstract entities are excluded because no file instantiates one. Nothing else
 * is: an earlier version of this also required `ObjectPlacement` and
 * `Representation`, on the reasoning that an entity with neither carries no
 * geometry to lose. That is true of MESHING and false of the ATTRIBUTE export,
 * which keeps a row for any product and never looks at attribute 6. Measured on
 * the pre-fix tree, the two rules select the same six entities, so the narrower
 * one cost nothing visible while quietly excusing a whole class of loss — the
 * shape this gate exists to stop.
 */
export function droppableProducts(tables) {
  const found = new Map();
  for (const { schema, table } of tables) {
    for (const e of table.values()) {
      if (e.isAbstract) continue;
      if (!reaches(table, e.name, 'IfcProduct')) continue;
      if (!found.has(e.name))
        found.set(e.name, {
          name: e.name,
          schema,
          parent: e.parent,
          bearsGeometry:
            e.attributes.includes('ObjectPlacement') && e.attributes.includes('Representation'),
        });
    }
  }
  return found;
}

export function checkCoverage({ legacySource, schemaSource, oldTables, tableSizes, allTableNames }) {
  const failures = [];
  const keys = legacyKeys(legacySource);
  const known = generatedNames(schemaSource);
  const droppable = droppableProducts(oldTables);

  // Vacuity: every extractor must find something, or "nothing is missing" is
  // a statement about the extractor rather than about the table.
  if (keys.size === 0) failures.push(`no arms extracted from ${LEGACY_REL} — the extractor has drifted`);
  if (known.size < 500)
    failures.push(`only ${known.size} names extracted from ${SCHEMA_REL}'s from_str — the extractor has drifted`);
  if (droppable.size === 0) failures.push(`no concrete products extracted from ${DATA_DIR} — the extractor has drifted`);
  // Sized PER TABLE, not over the union. The union is dominated by IFC2X3 and
  // IFC4, so a broken IFC4X3 extractor stays far above any union floor while
  // the dead-key half silently loses the only table that can vouch for an
  // IFC4X3-only name. Each table answers for itself.
  for (const [file, size] of tableSizes)
    if (size < 500) failures.push(`only ${size} entities extracted from ${file} — the extractor has drifted`);
  if (failures.length > 0) return failures;

  for (const p of [...droppable.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const upper = p.name.toUpperCase();
    if (known.has(upper) || keys.has(upper)) continue;
    failures.push(
      `${p.name} (${p.schema}, parent ${p.parent}) is a concrete IfcProduct, is not in the generated IFC4X3 enum, ` +
        `and has no arm in ${LEGACY_REL} — a file containing it loses it from the attribute export` +
        (p.bearsGeometry ? ' and from meshing' : ' (it carries no representation, so meshing loses nothing)'),
    );
  }

  // THE CONST MUST MIRROR THE ARMS. `LEGACY_ENTITY_NAMES` is public and feeds
  // the cross-language rooted-type universe, so an arm that never reaches it
  // shrinks that universe silently — which is how the three stratum leaves
  // stayed divergent with both halves of that gate green (#3124 review).
  //
  // This lives HERE rather than in a Rust test because the only way to state it
  // in-crate is `include_str!` of the module's own source — a source-text
  // assertion, which AGENTS.md bans and `check-rust-source-text-assertions`
  // (#3195) flags. Same call the repo already made for
  // `check-clash-degenerate-reason-parity.mjs`: a claim about two SOURCES
  // belongs in a lint, where reading both is the honest thing rather than the
  // banned thing.
  const constNames = legacyNameConst(legacySource);
  if (constNames.size === 0) {
    failures.push(
      `no names extracted from LEGACY_ENTITY_NAMES in ${LEGACY_REL} — the extractor has drifted, and two empty sets would otherwise "agree"`,
    );
  } else {
    const missingFromConst = [...keys].filter((k) => !constNames.has(k)).sort();
    const extraInConst = [...constNames].filter((k) => !keys.has(k)).sort();
    if (missingFromConst.length > 0)
      failures.push(
        `${LEGACY_REL} has match arms absent from LEGACY_ENTITY_NAMES: ${missingFromConst.join(', ')} — every consumer of that const, the rooted-type sweep's universe included, is blind to them`,
      );
    if (extraInConst.length > 0)
      failures.push(
        `LEGACY_ENTITY_NAMES lists ${extraInConst.join(', ')}, which is not a match arm in ${LEGACY_REL}`,
      );
  }

  // An arm whose key `IfcType::from_str` ALREADY resolves.
  //
  // `legacy_aware_ifc_type_from_record` (schema_helpers.rs) short-circuits on
  // `!matches!(decoded, IfcType::Unknown(_))` and only then consults this
  // table. That is equivalent to the native path ONLY while every key here is
  // a name the generated enum does not know. If a schema regeneration ever
  // emits an arm for one of these keys, the short-circuit fires, the remap is
  // skipped, and the browser diverges from the native path again -- which is
  // exactly the defect #3179 was filed for.
  //
  // Checked here rather than only in Rust because both sets are DERIVED from
  // source: a 27th arm added to the table is picked up automatically, where a
  // hand-written key list in a test would stay green and silently under-cover.
  for (const key of [...keys].sort()) {
    if (!known.has(key)) continue;
    failures.push(
      `${LEGACY_REL} has an arm for "${key}", which ${SCHEMA_REL}'s from_str already resolves`,
    );
  }

  for (const key of [...keys].sort()) {
    if (allTableNames.has(key)) continue;
    if (KEYS_ABSENT_FROM_EVERY_BUNDLED_TABLE.has(key)) continue;
    failures.push(
      `${LEGACY_REL} has an arm for "${key}", which names no entity in any bundled schema table — ` +
        `it can never match a real file. Check the spelling, or declare it in ` +
        `KEYS_ABSENT_FROM_EVERY_BUNDLED_TABLE with a reason`,
    );
  }

  return failures;
}

function loadTree(root) {
  const read = (rel) => readFileSync(join(root, rel), 'utf8');
  const oldTables = OLD_SCHEMAS.map((f) => ({
    schema: f.replace('entities-', '').replace('.ts', '').toUpperCase(),
    table: parseEntityTable(read(join(DATA_DIR, f))),
  }));
  const allTableNames = new Set();
  const tableSizes = [];
  for (const f of ALL_SCHEMAS) {
    const table = parseEntityTable(read(join(DATA_DIR, f)));
    tableSizes.push([f, table.size]);
    for (const name of table.keys()) allTableNames.add(name.toUpperCase());
  }
  return {
    legacySource: read(LEGACY_REL),
    schemaSource: read(SCHEMA_REL),
    oldTables,
    tableSizes,
    allTableNames,
  };
}

// Only run the gate when invoked as a script; the self-test imports the helpers.
if (process.argv[1] && process.argv[1].endsWith('check-legacy-entity-coverage.mjs')) {
  // Fail closed: a renamed or moved file must break this rather than silently
  // reduce it to zero comparisons.
  const tree = loadTree(ROOT);
  const failures = checkCoverage(tree);

  if (failures.length > 0) {
    // ONE table, read by both the router and the completeness guard below.
    //
    // #3204's messages arrived here unrouted because no remedy for that class
    // existed yet -- not because two lists disagreed. The two-list shape came
    // later, on this branch, when the guard was added with its own copy of the
    // keys; unifying them is what stops THAT drift, and a bare
    // `LEGACY_ENTITY_NAMES` key is what swallowed the const-drift message into
    // contradictory advice before the keys below were narrowed.
    //
    // Keys must be SPECIFIC. A key that matches a sibling class prints TWO
    // remedies for one failure, one of which tells the reader to fix something
    // that is not wrong. Which one appears first is table order below, not
    // failure order -- remedies are not attached to individual failures.
    const REMEDIES = [
      {
        keys: ['the extractor has drifted'],
        text: `
An extractor here returned nothing, or implausibly little, so this gate is
reading a subset of its inputs. Read nothing else above until it is resolved: a
half-blind gate reports a subset and looks like a pass.

Two causes produce the identical message and none of these checks can tell
them apart: either the source shape moved under this file's regexes, or the
input genuinely shrank and the regexes are fine. Check the input reported above
before editing either.
`,
      },
      {
        keys: ['from_str already resolves'],
        text: `
An arm whose key the generated enum already resolves is not a coverage gap, it
is a conflict. legacy_aware_ifc_type_from_record short-circuits whenever the
decoded type is not Unknown, so that arm's remap is skipped on the wasm path
while the native path still applies it -- the divergence #3179 was filed for.

REMOVE the arm: a name from_str resolves needs no legacy mapping. If the remap
is still wanted, the short-circuit in rust/core/src/schema_helpers.rs has to go
first, and that costs a record scan on every entity.
`,
      },
      {
        keys: ['names no entity'],
        text: `
An arm whose key names no entity in any bundled schema table can never match a
real file, so nothing is missing and nothing resolves to Unknown -- the arm is
simply dead. The table carried one from 2026-06-29 until #3172 removed it on
2026-08-25: IFCELECTRICALDISTRIBUTIONPOINT, with an "AL" no IFC2X3 entity has,
certified all the while by a test asserting the same misspelling.

Check the spelling against the bundled tables first. If the name is deliberate
and absent from all three, declare it in KEYS_ABSENT_FROM_EVERY_BUNDLED_TABLE
with the reason. Otherwise remove the arm.
`,
      },
      {
        keys: ['has no arm in'],
        text: `
Every pass that classifies an entity goes through this table, and a name it
misses resolves to IfcType::Unknown -- a subtype of nothing. The entity is then
dropped from the attribute export and from meshing at once, so nothing
disagrees and nothing looks wrong.

Add an arm mapping each name to its closest surviving IFC4X3 supertype (its own
parent chain in the older schema is the place to look, not a guess), and pin it
in rust/core/src/schema_helpers_tests.rs.
`,
      },
      {
        // Deliberately NOT a bare `LEGACY_ENTITY_NAMES`: that also matches the
        // const-vacuity message, whose fix is to repair this script's extractor,
        // not to edit a const that is already complete.
        keys: ['absent from LEGACY_ENTITY_NAMES', 'which is not a match arm in'],
        text: `
LEGACY_ENTITY_NAMES is public and feeds the cross-language rooted-type sweep, so
an arm the const omits makes that sweep structurally blind to the name -- which
is how the three stratum leaves stayed divergent with both halves of the
rooted-type gate green (#3124 review).

Add the missing name to the const, or delete the const entry that no arm
produces. The two must list exactly the same names; neither direction is the
safe one.
`,
      },
    ];

    // A drift failure is not necessarily an out-of-step table, and not
    // necessarily a broken extractor either: emptying an input produces the
    // identical message with the regexes untouched, and that emptied input may
    // itself be the table. Name neither side in the header.
    const drifted = failures.some((f) => f.includes('the extractor has drifted'));
    console.error(
      drifted
        ? `\nthese inputs did not read as expected:\n`
        : `\n${LEGACY_REL} is out of step with the bundled schema tables:\n`,
    );
    for (const f of failures) console.error(`  ${f}`);

    // ONE matcher. The key lists were unified above; leaving the predicate
    // written twice would let a change to the router (case-folding, a regex)
    // make every routed failure ALSO land in `unremedied`, printing a correct
    // remedy and "NO REMEDY MATCHED" for the same line.
    // ALL matches, not the first. Under first-match an over-broad earlier key
    // does not print two remedies -- it prints only the earlier, wrong one and
    // SUPPRESSES the correct one, with `unremedied` staying empty so the guard
    // never fires. Any-match keeps over-broadness loud: both remedies print,
    // in table order, and one of them plainly does not fit the failure list
    // above.
    const remediesFor = (f) => REMEDIES.filter((r) => r.keys.some((k) => f.includes(k)));

    for (const r of REMEDIES) {
      if (failures.some((f) => remediesFor(f).includes(r))) console.error(r.text);
    }

    // A failure matching no remedy prints its line and nothing else, which reads
    // as "no advice exists" rather than "the router missed it". Substring
    // dispatch cannot notice its own gaps, so the gap is named instead.
    const unremedied = failures.filter((f) => remediesFor(f).length === 0);
    if (unremedied.length > 0) {
      console.error(`
NO REMEDY MATCHED the failure(s) below. That is a defect in this script, not in
the table -- a new failure message was added without a matching remedy block.
Add one to REMEDIES, or reword the message to match an existing key:

${unremedied.map((f) => `  ${f}`).join('\n')}
`);
    }

    process.exit(1);
  }

  const exempt = KEYS_ABSENT_FROM_EVERY_BUNDLED_TABLE.size;
  console.log(
    `check-legacy-entity-coverage: OK (${legacyKeys(tree.legacySource).size} legacy arms, ` +
      `${droppableProducts(tree.oldTables).size} concrete legacy products all resolvable, ` +
      `${exempt} keys exempt by declaration)`,
  );
  for (const [key, why] of KEYS_ABSENT_FROM_EVERY_BUNDLED_TABLE) console.log(`  exempt: ${key} — ${why}`);
}
