#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Lint: every root-attribute field `extract_entity_metadata` (in
 * `apps/server/src/services/data_model/metadata.rs`) assigns must be read at
 * the SCHEMA-DERIVED index the per-type table hands it (`idx.<field>`), never
 * at a hardcoded literal — for all six fields: global_id, name, description,
 * object_type, tag, predefined_type.
 *
 * WHY THIS SHAPE, AND WHY IT IS NOT THE SAME AS THE EXISTING GATE (issue
 * #4053, residual 1 of #3979/#3966): #3949 was the server reading
 * `GlobalId`/`Name` at hardcoded `IfcRoot` positions (0/2) while the browser
 * resolved every type by its OWN schema attribute name.
 * `scripts/generate-server-attr-indices.mjs --check` (added by the #3949 fix,
 * PR #3956) already guards the TABLE half of that fix: it re-derives every
 * type's six indices from the same `getAttributeNames` the browser calls at
 * runtime and fails if the committed `generated/attr_indices.rs` has drifted
 * from that derivation. It does NOT guard the other half: whether
 * `metadata.rs` actually THREADS that table through for a given field, or
 * quietly reads a literal index again. Reintroducing the exact original bug
 * — hardcoding `global_id`/`name` back to 0/2 — leaves that gate GREEN (it
 * never opens metadata.rs), and only a hand-picked Rust unit test happens to
 * catch it for the one entity type (`IfcClassification`) that test exercises.
 * A field this repo's tests do not happen to distinguish for any covered
 * fixture type (verified: mutating `object_type` to a hardcoded `4` was
 * ALSO caught only by coincidence, because the `IfcWallType` fixture already
 * has `object_type` undeclared) would regress silently for the other ~770
 * types no fixture touches. This gate closes that gap directly and
 * structurally, for all six fields at once, without needing a fixture per
 * type: it reads metadata.rs's own source and asserts the WIRING, which by
 * construction covers every type the function ever runs for.
 *
 * VACUITY / UNDER-READ GUARD: `extractFieldReads` must find all six expected
 * `let <field> = string_at(&entity, …)` / `enum_at(&entity, …)` assignments.
 * Finding fewer means the function has been renamed, reshaped, or moved —
 * this gate has stopped reading the real code, and must fail LOUDLY rather
 * than silently pass by having nothing left to compare (mirrors the empty-set
 * guard in check-server-browser-type-parity.mjs and
 * check-clash-degenerate-reason-parity.mjs; see their headers for that
 * rationale).
 *
 * NOT A REPLACEMENT for `check:server-attr-indices` — that gate answers "is
 * the table itself correct"; this one answers "does the code actually use
 * it". Composed, the two together mean the server's runtime GlobalId / Name /
 * Description / ObjectType / Tag / PredefinedType output for every one of the
 * 776 IFC4_ADD2_TC1 entity types is provably the same schema-derived value
 * the browser resolves — which neither gate alone establishes.
 *
 * Run via `node scripts/check-server-attr-index-usage.mjs` (CI node-test job,
 * see .github/workflows/test.yml). `--root <dir>` points the read at an
 * alternate tree; `check-server-attr-index-usage.test.mjs` uses it to drive
 * the unmodified checker against mutated copies of the real source.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootFlag = process.argv.indexOf('--root');
const ROOT =
  rootFlag !== -1 && process.argv[rootFlag + 1]
    ? process.argv[rootFlag + 1]
    : join(dirname(fileURLToPath(import.meta.url)), '..');

export const METADATA_REL = 'apps/server/src/services/data_model/metadata.rs';

/**
 * The six root-attribute fields `extract_entity_metadata` assigns, in the
 * order the function declares them, and which accessor each must go through.
 * `global_id`/`name`/`description`/`object_type`/`tag` are plain strings
 * (`string_at`); `predefined_type` is a STEP enum token (`enum_at`) — see
 * metadata.rs's own doc comments for why the two accessors differ.
 */
export const EXPECTED_FIELDS = [
  { field: 'global_id', accessor: 'string_at' },
  { field: 'name', accessor: 'string_at' },
  { field: 'description', accessor: 'string_at' },
  { field: 'object_type', accessor: 'string_at' },
  { field: 'tag', accessor: 'string_at' },
  { field: 'predefined_type', accessor: 'enum_at' },
];

/** Strips `/* … *‍/` and `//` comments — same naive, symmetric strip the
 * sibling parity lints in this directory use; metadata.rs's relevant lines
 * carry no string literals containing either. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * For each expected field, finds its `let <field> = <accessor>(&entity, …);`
 * assignment in metadata.rs and captures the exact index EXPRESSION passed as
 * the second argument (e.g. `idx.global_id`, or a bare literal like `0`).
 *
 * @returns {Map<string, string>} field name -> captured index expression,
 * only for fields actually found. A field absent from the map means this
 * extractor could not locate its assignment at all (see `checkUsage`'s
 * under-read handling below) — distinct from finding it wired to the wrong
 * expression.
 */
export function extractFieldReads(rustSource) {
  const code = stripComments(rustSource);
  const found = new Map();
  for (const { field, accessor } of EXPECTED_FIELDS) {
    const re = new RegExp(`let\\s+${field}\\s*=\\s*${accessor}\\(&entity,\\s*([^)]+?)\\s*\\);`);
    const m = re.exec(code);
    if (m) found.set(field, m[1].trim());
  }
  return found;
}

/**
 * @returns {{failures: string[], underRead: boolean}} failures empty means
 * every field is wired to its schema-derived index; underRead means this
 * extractor could not find all six expected assignments at all (the function
 * has moved/renamed/reshaped) and refused to compare rather than silently
 * passing on whatever subset it happened to find.
 */
export function checkUsage(rustSource) {
  const reads = extractFieldReads(rustSource);

  if (reads.size < EXPECTED_FIELDS.length) {
    const missing = EXPECTED_FIELDS.map((f) => f.field).filter((f) => !reads.has(f));
    return {
      failures: [
        `only found ${reads.size}/${EXPECTED_FIELDS.length} expected field-read assignments in ${METADATA_REL} — missing: ${missing.join(', ')}. extract_entity_metadata may have moved, been renamed, or been reshaped; this gate has stopped reading the real code.`,
      ],
      underRead: true,
    };
  }

  const failures = [];
  for (const { field } of EXPECTED_FIELDS) {
    const expr = reads.get(field);
    const expected = `idx.${field}`;
    if (expr !== expected) {
      failures.push(
        `\`${field}\` is read as \`${expr}\`, not \`${expected}\` — it is not going through the schema-derived per-type index table (generated/attr_indices.rs) and will read the same hardcoded position for every entity type, regardless of what that type actually declares. This is the exact shape of issue #3949.`,
      );
    }
  }
  return { failures, underRead: false };
}

if (process.argv[1] && process.argv[1].endsWith('check-server-attr-index-usage.mjs')) {
  const rustSource = readFileSync(join(ROOT, METADATA_REL), 'utf8');
  const { failures, underRead } = checkUsage(rustSource);

  if (failures.length > 0) {
    console.error(`\ncheck-server-attr-index-usage: ${METADATA_REL} drifted\n`);
    for (const f of failures) console.error(`  ${f}`);
    if (underRead) {
      console.error(`
This gate could not find all six expected field-read assignments, so it
compared nothing and is not reporting on usage parity at all. Read
${METADATA_REL}
and either restore the recognizable \`let <field> = string_at(&entity,
idx.<field>);\` / \`enum_at(...)\` shape, or update EXPECTED_FIELDS /
extractFieldReads in scripts/check-server-attr-index-usage.mjs to match the
new shape.
`);
    } else {
      console.error(`
A field read at a literal index instead of \`idx.<field>\` silently reverts to
the pre-#3949 behaviour for every type whose schema position differs from
that literal. Fix the read in ${METADATA_REL} to go through \`idx\` (from
\`root_attr_indices\`), the way every other field in the same function does.
`);
    }
    process.exit(1);
  }

  console.log(
    `check-server-attr-index-usage: OK (${EXPECTED_FIELDS.length}/${EXPECTED_FIELDS.length} fields wired to the schema-derived index table in ${METADATA_REL})`,
  );
}
