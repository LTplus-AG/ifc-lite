#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Lint: for each of several concepts (relationships, spatial types,
 * properties, quantities, materials), the set of IFC type names the Rust
 * server (`apps/server/src/services/data_model/*.rs`) switches on must match
 * the set the TypeScript/browser parser (`packages/parser/src/*.ts`,
 * `packages/data/src/*.ts`) switches on — with an explicit, documented
 * allowlist for divergences that are intentional or already being fixed.
 *
 * WHY THIS SHAPE (issue #3966): five defects in two days were the same
 * pattern — the Rust server path and the TS/WASM path independently
 * implement the same extraction, drift apart, and nothing notices because
 * each side is internally self-consistent (#3949, #3948/#3955, #3963,
 * #3964, #3965). Georeferencing already has a dual-implementation parity
 * harness driven by shared fixture vectors
 * (`rust/core/tests/georef_parity.rs` / `packages/parser/src/georef.parity.test.ts`);
 * building the equivalent OUTPUT-comparison harness for these five concepts
 * would mean inventing a shared fixture format for five different data
 * shapes across two languages, which is real work with no shortcut. The
 * issue itself names the cheap version that would have caught three of the
 * five: comparing the two sides' TYPE-NAME SETS. This gate is that version.
 *
 * APPROACH CHOSEN, AND WHY: parse both sources for the type-name string
 * literals they switch on (`scripts/check-clash-degenerate-reason-parity.mjs`
 * is the precedent for this exact shape in this repo, and its own header
 * explains why it lives here rather than in a test file: reading two
 * SOURCES and diffing their text is exactly what
 * `check-source-text-assertions.mjs` bans inside a test, because there it
 * would be standing in for running the code. Here there is no way to run
 * either side "and compare": there is no shared fixture format, and the two
 * outputs (Rust `PropertySet`/`Relationship`/... vs TS `IfcDataStore`
 * columnar tables) do not share a wire shape to diff. A structural read of
 * both sources is the only thing that can name "what a type SWITCHES ON"; a
 * lint is the honest place for it, same call the clash-reason and
 * legacy-entity-coverage gates already made). This is brittle to a rename or
 * a source reshuffle (documented per concept below) but requires no runtime
 * and catches exactly the defect shape all five instances had: a type
 * present in one match/switch and silently absent from the other.
 *
 * WHAT THIS DOES NOT COVER: attribute INDICES within a matched type (e.g. a
 * type present on both sides but reading the wrong attribute offset — #3949
 * was that shape, not a missing-type shape), edge ORIENTATION (which side is
 * "relating" vs "related"), or VALUE semantics once a type is matched. Only
 * the set of type names each side is willing to handle at all.
 *
 * VACUITY GUARD, per concept: both extractors must return a non-empty set.
 * Two empty sets are "equal", so a broken extractor (source moved, regex
 * anchor drifted) would otherwise pass silently instead of reporting drift.
 * ONE EXCEPTION: `tsPropertyTypes` unconditionally seeds its result with
 * `IFCPROPERTYSINGLEVALUE` (see that function's doc comment — the TS
 * `default` switch arm has no quoted literal for a regex to find), so
 * `properties` TS-side can never be empty and that half of this guard can
 * never fire for that one concept. This is deliberate — the seed is correct
 * behaviour, not a bug to "fix" by removing it — but it means the guard is
 * NOT actually bilateral for `properties`: only the Rust side can trip it
 * there. Every other concept's guard is bilateral as documented.
 *
 * UNDER-READ GUARD, relationships only: `rustRelationshipTypes` and
 * `tsRelationshipTypes` each read ONE bounded region (`rel_types`; the three
 * `*_REL_TYPES` Sets) and throw `ExtractorUnderReadError` — caught below and
 * reported as a third failure category, distinct from vacuity — if a SIBLING
 * binding that looks like it carries more IFC type literals exists in the
 * same file. This closes a silent-pass shape found in review: a later patch
 * adding types via a new `let extra_rel_types = [...]` array (or a fourth
 * `*_REL_TYPES` Set) alongside the existing one would otherwise never be
 * read by this extractor, and the stale allowlist would keep the gate quiet
 * about it. See `scripts/lib/server-browser-type-extractors.mjs` for the
 * detector and its scoping rationale (why it does not also fire on this
 * file's other, unrelated `*_TYPES` sets).
 *
 * THE ALLOWLIST is the mechanism that keeps this gate from being either
 * useless (allowlisting everything) or naggy (failing on every open fix in
 * flight). Every entry names the exact type, the concept, and WHY it is
 * listed — a tracked deliberate gap (#3254) or an open PR already fixing the
 * exact divergence this gate would otherwise report (#3969/#3971/#3973). A
 * divergence not on the list fails loudly; the list only ever grows with a
 * reviewed reason attached, never silently.
 *
 * Run via `node scripts/check-server-browser-type-parity.mjs` (CI node-test
 * job, see .github/workflows/test.yml). `--root <dir>` points every read at
 * an alternate tree; `check-server-browser-type-parity.test.mjs` uses it to
 * drive the unmodified checker against mutated copies of the real sources.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  rustRelationshipTypes,
  tsRelationshipTypes,
  rustSpatialTypes,
  tsSpatialTypes,
  rustPropertyTypes,
  tsPropertyTypes,
  rustQuantityTypes,
  tsQuantityTypes,
  rustMaterialTypes,
  tsMaterialTypes,
  ExtractorUnderReadError,
} from './lib/server-browser-type-extractors.mjs';

const rootFlag = process.argv.indexOf('--root');
const ROOT =
  rootFlag !== -1 && process.argv[rootFlag + 1]
    ? process.argv[rootFlag + 1]
    : join(dirname(fileURLToPath(import.meta.url)), '..');

function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}


// ---------------------------------------------------------------------------

const RUST_REL = 'apps/server/src/services/data_model/relationships.rs';
const TS_REL_INDEXES = 'packages/parser/src/columnar-parser-indexes.ts';
const RUST_SPATIAL = 'apps/server/src/services/data_model/spatial.rs';
const TS_SPATIAL = 'packages/data/src/spatial-types.ts';
const RUST_PROPS = 'apps/server/src/services/data_model/properties.rs';
const TS_PROPS = 'packages/parser/src/property-value-parser.ts';
const RUST_QTY = 'apps/server/src/services/data_model/quantities.rs';
const TS_QTY_MAP = 'packages/parser/src/columnar-parser-indexes.ts';
const TS_QTY_COLLECT = 'packages/parser/src/quantity-collect.ts';
const RUST_MATERIALS = 'apps/server/src/services/data_model/materials.rs';
const TS_MATERIALS = 'packages/parser/src/material-resolver.ts';

/**
 * The allowlist. Every key is `${concept}:${TYPE_NAME}`. Every value is
 * `{ status, note }`:
 *
 *   - `status: 'deliberate'` — a SETTLED trade-off with its own tracking
 *     issue (e.g. #3254). Nobody is going to "fix" this; the note says why
 *     not, and a future agent should read the linked issue before touching
 *     either side's behaviour here.
 *   - `status: 'pending'` — a KNOWN divergence with an open PR already
 *     addressing it, OR flagged to a maintainer with the resolution not yet
 *     decided (e.g. "drop it / add it to the other side / keep and
 *     allowlist" are all still on the table). This gate does not assume an
 *     outcome: it only records that the gap is known and not silent.
 *
 * The distinction matters because the two failure modes it guards against
 * are different: a `deliberate` entry that quietly starts being used as
 * cover for an unrelated new gap is caught by this gate still comparing the
 * type EXACTLY (an allowlist entry suppresses one named type on one named
 * side, never a whole concept); a `pending` entry that outlives its PR
 * closing keeps citing a merged issue number, which is the trigger to
 * re-check whether it can be deleted.
 *
 * An entry here does not fix or hide the divergence: the type genuinely IS
 * absent from one side today, and a reader of this file can go verify that.
 */
export const ALLOWLIST = {
  // #3964: server extracts 9 IfcRel* types, TS ~19. Open PR #3969 adds
  // IfcRelAssignsToGroup(ByFactor)/Nests/ConnectsPathElements server-side;
  // the remaining connect/port/space-boundary/referenced-in-spatial-structure
  // types are the same shape of gap and tracked under the same issue.
  'relationships:IFCRELNESTS': { status: 'pending', note: '#3964, open PR #3969' },
  'relationships:IFCRELASSIGNSTOGROUP': { status: 'pending', note: '#3964, open PR #3969' },
  // Server-side gap only: already present on the TS side (HIERARCHY_REL_TYPES
  // and REL_TYPE_MAP in columnar-parser-indexes.ts, mapped onto the same
  // RelationshipType.AssignsToGroup bucket as plain IFCRELASSIGNSTOGROUP, so
  // the Groups panel/"By Zone" lens/IDS partOf already see it). Verified
  // against upstream/main directly (`grep -rn IFCRELASSIGNSTOGROUPBYFACTOR
  // packages/ apps/`) and against PR #3969's diff, which touches only
  // apps/server — no TS-side change. Kept `pending` rather than `deliberate`:
  // PR #3969 has an open maintainer question on whether the server should
  // even carry this type, so the SERVER-side shape (not the browser side) is
  // what is undecided.
  'relationships:IFCRELASSIGNSTOGROUPBYFACTOR': { status: 'pending', note: '#3964, open PR #3969 — maintainer question open on whether the server should carry this type at all' },
  'relationships:IFCRELCONNECTSPATHELEMENTS': { status: 'pending', note: '#3964, open PR #3969' },
  'relationships:IFCRELCONNECTSELEMENTS': { status: 'pending', note: '#3964, tracked with #3969' },
  'relationships:IFCRELCONNECTSPORTTOELEMENT': { status: 'pending', note: '#3964, tracked with #3969' },
  'relationships:IFCRELCONNECTSPORTS': { status: 'pending', note: '#3964, tracked with #3969' },
  'relationships:IFCRELSPACEBOUNDARY': { status: 'pending', note: '#3964, tracked with #3969' },
  'relationships:IFCRELASSIGNSTOPRODUCT': { status: 'pending', note: '#3964, tracked with #3969' },
  'relationships:IFCRELREFERENCEDINSPATIALSTRUCTURE': { status: 'pending', note: '#3964, tracked with #3969' },

  // #3965: server never promotes a *contained* (not aggregated) spatial
  // element into its own hierarchy node. TS treats IfcSpatialZone (the
  // Revit Family+Dynamo pattern), IfcMarinePart and IfcFacilityPartCommon as
  // spatial-structure nodes; the server's `is_spatial_type` does not yet.
  // Open PR #3973 closes #3965.
  'spatialTypes:IFCSPATIALZONE': { status: 'pending', note: '#3965, open PR #3973' },
  'spatialTypes:IFCMARINEPART': { status: 'pending', note: '#3965, tracked with #3973' },
  'spatialTypes:IFCFACILITYPARTCOMMON': { status: 'pending', note: '#3965, tracked with #3973' },

  // #3963: the server has no IFCCOMPLEXPROPERTY arm at all and drops the
  // whole containing PropertySet; the browser path resolves it via
  // parsePropertyValueWithComplex. Open PR #3971 closes #3963.
  'properties:IFCCOMPLEXPROPERTY': { status: 'pending', note: '#3963, open PR #3971' },

  // #3254: IfcPhysicalComplexQuantity groups other quantities instead of
  // carrying a measure itself, so neither side resolves it to a Quantity —
  // this is a DELIBERATE, tracked trade-off, not an in-flight fix. The
  // server never names the type at all; the TS side names it only to skip
  // it explicitly (`quantity-collect.ts`'s COMPLEX_QUANTITY_TYPE). Do not
  // remove this entry to "fix" the gap — see #3254 before changing either
  // side's behaviour here.
  'quantities:IFCPHYSICALCOMPLEXQUANTITY': { status: 'deliberate', note: '#3254 (deliberate, tracked gap)' },
};

const CONCEPTS = [
  {
    name: 'relationships',
    rust: () => rustRelationshipTypes(read(RUST_REL)),
    ts: () => tsRelationshipTypes(read(TS_REL_INDEXES)),
    rustLabel: RUST_REL,
    tsLabel: TS_REL_INDEXES,
  },
  {
    name: 'spatialTypes',
    rust: () => rustSpatialTypes(read(RUST_SPATIAL)),
    ts: () => tsSpatialTypes(read(TS_SPATIAL)),
    rustLabel: RUST_SPATIAL,
    tsLabel: TS_SPATIAL,
  },
  {
    name: 'properties',
    rust: () => rustPropertyTypes(read(RUST_PROPS)),
    ts: () => tsPropertyTypes(read(TS_PROPS)),
    rustLabel: RUST_PROPS,
    tsLabel: TS_PROPS,
  },
  {
    name: 'quantities',
    rust: () => rustQuantityTypes(read(RUST_QTY)),
    ts: () => tsQuantityTypes(read(TS_QTY_MAP), read(TS_QTY_COLLECT)),
    rustLabel: RUST_QTY,
    tsLabel: `${TS_QTY_MAP}, ${TS_QTY_COLLECT}`,
  },
  {
    name: 'materials',
    rust: () => rustMaterialTypes(read(RUST_MATERIALS)),
    ts: () => tsMaterialTypes(read(TS_MATERIALS)),
    rustLabel: RUST_MATERIALS,
    tsLabel: TS_MATERIALS,
  },
];

/**
 * @returns {{failures: string[], vacuous: boolean, underRead: boolean}}
 * failures empty means parity holds (given the allowlist); vacuous means at
 * least one side's extractor returned nothing, so no comparison was actually
 * made; underRead means an extractor detected a sibling binding it cannot be
 * sure it read (see `ExtractorUnderReadError`) and refused to compare rather
 * than silently under-reporting.
 */
export function checkConcept(concept) {
  let rust, ts;
  try {
    rust = concept.rust();
    ts = concept.ts();
  } catch (e) {
    if (e instanceof ExtractorUnderReadError) {
      return { failures: [`[${concept.name}] ${e.message}`], vacuous: false, underRead: true };
    }
    throw e;
  }
  const failures = [];

  if (rust.size === 0) {
    failures.push(
      `[${concept.name}] no types extracted from ${concept.rustLabel} — the extractor has drifted from the Rust source`,
    );
  }
  if (ts.size === 0) {
    failures.push(
      `[${concept.name}] no types extracted from ${concept.tsLabel} — the extractor has drifted from the TS source`,
    );
  }
  if (failures.length > 0) return { failures, vacuous: true, underRead: false };

  const isAllowlisted = (t) => Object.hasOwn(ALLOWLIST, `${concept.name}:${t}`);

  const missingFromTs = [...rust].filter((t) => !ts.has(t) && !isAllowlisted(t)).sort();
  const missingFromRust = [...ts].filter((t) => !rust.has(t) && !isAllowlisted(t)).sort();

  if (missingFromTs.length > 0) {
    failures.push(
      `[${concept.name}] the Rust server (${concept.rustLabel}) handles ${missingFromTs.map((t) => `\`${t}\``).join(', ')} but the TS parser (${concept.tsLabel}) does not`,
    );
  }
  if (missingFromRust.length > 0) {
    failures.push(
      `[${concept.name}] the TS parser (${concept.tsLabel}) handles ${missingFromRust.map((t) => `\`${t}\``).join(', ')} but the Rust server (${concept.rustLabel}) does not`,
    );
  }
  return { failures, vacuous: false, underRead: false };
}

/** Every allowlist entry must carry a recognized status — an unstructured or
 * misspelled one would silently stop suppressing anything (falling through
 * `isAllowlisted`'s `Object.hasOwn` check still works, but a status typo
 * would be invisible to a reader trying to tell settled from pending). */
export function validateAllowlist(allowlist) {
  const bad = Object.entries(allowlist).filter(
    ([, v]) => !v || (v.status !== 'deliberate' && v.status !== 'pending') || !v.note,
  );
  return bad.map(([k]) => k);
}

if (process.argv[1] && process.argv[1].endsWith('check-server-browser-type-parity.mjs')) {
  const badEntries = validateAllowlist(ALLOWLIST);
  if (badEntries.length > 0) {
    console.error(
      `\ncheck-server-browser-type-parity: malformed ALLOWLIST entries (need {status: 'deliberate'|'pending', note}): ${badEntries.join(', ')}\n`,
    );
    process.exit(1);
  }

  let anyFailed = false;
  let anyVacuous = false;
  let anyUnderRead = false;
  const okLines = [];

  for (const concept of CONCEPTS) {
    const { failures, vacuous, underRead } = checkConcept(concept);
    if (failures.length === 0) {
      okLines.push(`  ${concept.name}: OK`);
      continue;
    }
    anyFailed = true;
    if (vacuous) anyVacuous = true;
    if (underRead) anyUnderRead = true;
    console.error(`\ncheck-server-browser-type-parity: ${concept.name} drifted\n`);
    for (const f of failures) console.error(`  ${f}`);
  }

  if (anyFailed) {
    if (anyVacuous) {
      console.error(`
An extractor above returned NOTHING, so this gate compared nothing for that
concept and is not reporting on parity at all. Two causes look identical from
here: the source shape moved under this file's regexes, or the type really
was removed from that file. Read the named file and decide which, then fix
that — the extractor in scripts/check-server-browser-type-parity.mjs, or the
source.
`);
    }
    if (anyUnderRead) {
      console.error(`
An extractor above found a SIBLING binding it does not know how to read,
alongside the one it does — the extractor may be under-reading, so its
result cannot be trusted as complete and this gate refused to compare it.
This is not the vacuity case (the extractor did find types); it is the
"secondary array/set added later" shape found in review. Read the named
file, decide whether the new binding needs to be read too, and update the
extractor in scripts/lib/server-browser-type-extractors.mjs accordingly.
`);
    }
    console.error(`
A type present on one side and not the other is either a genuine divergence
(fix it, or add a documented ALLOWLIST entry naming the issue/PR that is
already fixing it — never an undocumented one) or this checker's extractor
missing a shape it should have recognized (fix the extractor).
`);
    process.exit(1);
  }

  console.log('check-server-browser-type-parity: OK');
  for (const line of okLines) console.log(line);
  const pending = Object.entries(ALLOWLIST).filter(([, v]) => v.status === 'pending');
  const deliberate = Object.entries(ALLOWLIST).filter(([, v]) => v.status === 'deliberate');
  console.log(
    `  allowlist: ${pending.length} pending (open PR/decision), ${deliberate.length} deliberate (settled trade-off)`,
  );
}
