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
    console.error(`\n${LEGACY_REL} is out of step with the bundled schema tables:\n`);
    for (const f of failures) console.error(`  ${f}`);
    console.error(`
Every pass that classifies an entity goes through this table, and a name it
misses resolves to IfcType::Unknown -- a subtype of nothing. The entity is then
dropped from the attribute export and from meshing at once, so nothing
disagrees and nothing looks wrong.

Add an arm mapping each name to its closest surviving IFC4X3 supertype (its own
parent chain in the older schema is the place to look, not a guess), and pin it
in rust/core/src/schema_helpers_tests.rs.
`);
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
