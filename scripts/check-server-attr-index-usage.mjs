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
 * Tolerant of rustfmt wrapping the call onto multiple lines (whitespace
 * around the opening paren and a trailing comma before the closing one) —
 * without that, a call that happens to exceed the line-length limit and gets
 * reformatted would silently fail to match at all and be reported as a
 * MISSING assignment (see `checkUsage`'s under-read path) rather than
 * compared, which is a false alarm over formatting, not the field-drift
 * signal this gate exists to give.
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
    const re = new RegExp(
      `let\\s+${field}\\s*=\\s*${accessor}\\(\\s*&entity,\\s*([^)]+?)\\s*,?\\s*\\);`,
    );
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

const KNOWN_FIELDS = new Set(EXPECTED_FIELDS.map((f) => f.field));

/**
 * INVERSION of checkUsage: instead of asking "are the six fields we know
 * about wired to idx.<field>?", this asks "is EVERY `string_at`/`enum_at`
 * call against `&entity`, however named, wired to `idx.<field>` — whatever
 * that field is?". checkUsage's EXPECTED_FIELDS list is necessarily fixed at
 * the six fields known when this gate was written; a SEVENTH field added
 * later with a hardcoded literal index (the exact #3949 defect shape, just
 * on a field this gate was never told to look for) passes checkUsage with a
 * clean `OK (6/6)` because checkUsage never looks past the six names it was
 * given. Verified: adding `let owner_history = string_at(&entity, 5);` to
 * metadata.rs left the pre-existing checker (fixed six-field EXPECTED_FIELDS
 * list) reporting `OK (6/6 fields wired ...)` unchanged.
 *
 * This scans metadata.rs's own source for every `(string_at|enum_at)(&entity,
 * <expr>)` call — named via a `let <name> = ...` binding or not — and flags
 * any whose index expression is not the schema-derived `idx.<field>` shape.
 * Calls bound to one of the six KNOWN_FIELDS are skipped here: checkUsage
 * already reports on those specifically (with an accessor-aware regex and a
 * message naming the exact expected accessor), so this only reports on
 * fields checkUsage does not know to check — the blind spot. That makes the
 * two checks complementary rather than duplicative: checkUsage answers "are
 * the six fields we know about right", this answers "is there any field we
 * DON'T know about, read at a literal index".
 *
 * False-positive check performed against this file itself: the only other
 * literal index use in metadata.rs is `UNKNOWN_TYPE_FALLBACK`'s struct
 * literal (`RootAttrIndices { global_id: 0, name: 2, ... }`) and the `idx <
 * 0` / `idx as usize` literals inside `string_at`/`enum_at`'s OWN bodies —
 * neither is a `(string_at|enum_at)(&entity, ...)` call, so neither matches.
 *
 * @returns {string[]} one failure message per unaudited literal-indexed call
 * found; empty if every string_at/enum_at(&entity, …) call in the file goes
 * through `idx.<field>`.
 */
export function findUnauditedLiteralReads(rustSource) {
  const code = stripComments(rustSource);
  const re = /(?:let\s+(\w+)\s*=\s*)?(string_at|enum_at)\(\s*&entity,\s*([^)]+?)\s*,?\s*\)/g;
  const failures = [];
  let m;
  while ((m = re.exec(code)) !== null) {
    const [, name, accessor, rawExpr] = m;
    if (name && KNOWN_FIELDS.has(name)) continue; // already reported by checkUsage
    const expr = rawExpr.trim();
    if (/^idx\.[A-Za-z_]\w*$/.test(expr)) continue; // schema-derived, fine
    const label = name ? `\`${name}\`` : 'an unnamed call';
    failures.push(
      `${label} is read via \`${accessor}(&entity, ${expr})\` at a literal/non-schema-derived index, not \`idx.<field>\` — a field this gate's fixed six-field EXPECTED_FIELDS list does not know to check by name, so checkUsage cannot see it. This is the same shape as issue #3949: it will read the same hardcoded position for every entity type, regardless of what that type actually declares. If this is a legitimate new field, wire it through \`idx.<field>\` (adding the field to generated/attr_indices.rs and RootAttrIndices first if needed) and add it to EXPECTED_FIELDS in scripts/check-server-attr-index-usage.mjs so checkUsage audits it by name too.`,
    );
  }
  return failures;
}

/**
 * Every check above (`checkUsage`, `findUnauditedLiteralReads`) trusts that
 * `idx.<field>` is actually the schema-derived table `root_attr_indices`
 * returned — it only verifies the REFERENCE (`idx.<field>` in the source
 * text), never `idx`'s own PROVENANCE. That leaves an evasion the fixed-six
 * text match cannot see: shadow `idx` with a second binding right after the
 * real one —
 *
 *   let idx = root_attr_indices(&upper).unwrap_or(UNKNOWN_TYPE_FALLBACK);
 *   let idx = UNKNOWN_TYPE_FALLBACK;   // shadow
 *
 * — and every `idx.<field>` read below still says `idx.<field>` verbatim, so
 * checkUsage still reports a clean 6/6 and findUnauditedLiteralReads finds no
 * literal index at all, while every field resolves to the fallback for every
 * entity type: the exact #3949 defect, shipped green (found during review of
 * PR #4082, the fixed-six-field gate this file was originally about).
 *
 * This scans for every `idx = <expr>;` statement in the file (`let idx = …`
 * or a bare reassignment) and fails if there is more than one `let idx = …`
 * binding, if the single binding's right-hand side does not call
 * `root_attr_indices(`, or if `idx` is reassigned outside a `let` at all.
 *
 * SCOPE NOTE: this is deliberately textual, like the rest of this gate, not
 * a Rust parser — it does not track lexical scopes, so it cannot distinguish
 * two *sibling* functions that each legitimately declare their own local
 * `idx` (there are none today; `extract_entity_metadata` is the only
 * function in this file using the name) from a shadow inside the SAME
 * function. If a second, unrelated `idx` is ever introduced in another
 * function in this file, this check will need scope-awareness it does not
 * have — left undone deliberately rather than half-built, per the brief not
 * to turn this into a parser.
 *
 * @returns {string[]} failure messages; empty if idx's provenance checks out.
 */
export function checkIdxProvenance(rustSource) {
  const code = stripComments(rustSource);
  // Matches both `let idx = …;` / `let mut idx = …;` (group 1 present) and a
  // bare reassignment `idx = …;` (group 1 absent). The `(?!=)` after `=`
  // keeps this off `idx == …` comparisons; the `\b` before `idx` keeps it
  // off identifiers merely ending in "idx" (e.g. `some_idx`).
  const re = /(let\s+(?:mut\s+)?)?\bidx\s*=(?!=)\s*([^;]+);/g;
  const letBindings = [];
  const reassignments = [];
  let m;
  while ((m = re.exec(code)) !== null) {
    const [, letPrefix, rawExpr] = m;
    const expr = rawExpr.trim();
    if (letPrefix) {
      letBindings.push(expr);
    } else {
      reassignments.push(expr);
    }
  }

  const failures = [];

  if (letBindings.length === 0) {
    failures.push(
      `no \`let idx = …;\` binding found in ${METADATA_REL} — this gate could not verify \`idx\`'s provenance at all; it may have been renamed or restructured.`,
    );
    return failures;
  }

  if (letBindings.length > 1) {
    failures.push(
      `found ${letBindings.length} \`let idx = …;\` bindings of \`idx\` in ${METADATA_REL} (${letBindings.map((e) => `\`${e}\``).join(', ')}) — a second binding SHADOWS the first, silently replacing what every \`idx.<field>\` read below resolves to, regardless of what those reads say in the source text. Only one \`let idx = root_attr_indices(...)\` binding is allowed; remove the extra binding(s). This is the exact shape of issue #3949, one level removed: the fields still read \`idx.<field>\`, but \`idx\` itself no longer comes from the schema-derived table.`,
    );
  } else if (!/root_attr_indices\s*\(/.test(letBindings[0])) {
    failures.push(
      `\`idx\` is bound as \`let idx = ${letBindings[0]};\` in ${METADATA_REL}, not from \`root_attr_indices(...)\` — every \`idx.<field>\` read below is only as trustworthy as \`idx\`'s own provenance, and this binding does not come from the schema-derived per-type index table.`,
    );
  }

  if (reassignments.length > 0) {
    failures.push(
      `\`idx\` is reassigned after its initial binding in ${METADATA_REL} (\`idx = ${reassignments[0]};\`) — \`idx\` must be established exactly once, via \`let idx = root_attr_indices(...)\`, and never mutated afterward.`,
    );
  }

  return failures;
}

if (process.argv[1] && process.argv[1].endsWith('check-server-attr-index-usage.mjs')) {
  const rustSource = readFileSync(join(ROOT, METADATA_REL), 'utf8');
  const { failures, underRead } = checkUsage(rustSource);
  const strayFailures = findUnauditedLiteralReads(rustSource);
  const idxFailures = underRead ? [] : checkIdxProvenance(rustSource);
  const allFailures = [...failures, ...strayFailures, ...idxFailures];

  if (allFailures.length > 0) {
    console.error(`\ncheck-server-attr-index-usage: ${METADATA_REL} drifted\n`);
    for (const f of allFailures) console.error(`  ${f}`);
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
    } else if (failures.length > 0) {
      console.error(`
A field read at a literal index instead of \`idx.<field>\` silently reverts to
the pre-#3949 behaviour for every type whose schema position differs from
that literal. Fix the read in ${METADATA_REL} to go through \`idx\` (from
\`root_attr_indices\`), the way every other field in the same function does.
`);
    }
    if (strayFailures.length > 0) {
      console.error(`
This gate's six-field EXPECTED_FIELDS list did not name the field(s) above,
so checkUsage's per-field comparison never saw them — but every
\`string_at\`/\`enum_at\` call against \`&entity\` in ${METADATA_REL} is
checked regardless of name, and a literal index there is the same #3949 risk
as a literal index on one of the six known fields.
`);
    }
    if (idxFailures.length > 0) {
      console.error(`
Every \`idx.<field>\` check above only verifies the REFERENCE in the source
text — it trusts that \`idx\` itself still comes from
\`root_attr_indices(...)\`. A second/shadowing \`let idx = …;\` binding, or a
reassignment, replaces what \`idx.<field>\` resolves to for every field at
once without changing a single \`idx.<field>\` occurrence in the text. Fix
\`idx\`'s binding in ${METADATA_REL} so it is established exactly once, from
\`root_attr_indices(...)\`.
`);
    }
    process.exit(1);
  }

  console.log(
    `check-server-attr-index-usage: OK (${EXPECTED_FIELDS.length}/${EXPECTED_FIELDS.length} fields wired to the schema-derived index table in ${METADATA_REL}, and no unaudited literal-indexed string_at/enum_at(&entity, …) calls found)`,
  );
}
