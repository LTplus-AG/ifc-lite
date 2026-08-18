#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Lint: `ClashSolidDegenerateReason` (TypeScript) must declare exactly the
 * `degenerateReason` strings the wasm binding `clash_solid.rs` can emit.
 *
 * The reason crosses the wasm boundary as an untyped string and is cast
 * (`as ClashSolidDegenerateReason`) on arrival, so TypeScript cannot catch a
 * union that has drifted from the kernel. `'malformed-operand'` was missing for
 * exactly that reason: it is produced by the BINDING's own operand validation
 * (`mesh_from`), not by the geometry crate's `DegenerateReason` enum the
 * union's doc comment says it mirrors — so mirroring the enum silently missed
 * it.
 *
 * THIS is a lint, not a test, and it started life inside
 * `apps/viewer/src/lib/clash/intersection-solid.test.ts` until the repo's own
 * `check-source-text-assertions` gate caught it there. The gate was right: a
 * cross-language declaration parity claim can only ever be made by reading both
 * SOURCES, which is precisely the shape banned in test files. Naming it a check
 * makes the shape honest and leaves the test file executable end to end — the
 * behavioural half (a malformed operand really does yield `'malformed-operand'`
 * from the real wasm kernel) stays there, where it belongs.
 *
 * VACUITY GUARD: both extractors must come back non-empty. Two empty sets are
 * "equal", so an extractor broken by a refactor would otherwise turn this into
 * a check that passes by finding nothing.
 *
 * COMMENTS ARE STRIPPED FIRST on both sides, symmetrically: a reason named only
 * in prose must not stand in for a real one, in either language.
 *
 * Run via `node scripts/check-clash-degenerate-reason-parity.mjs` (CI node-test
 * job). `--root <dir>` points it at a mutated copy of the tree; that is how
 * `check-clash-degenerate-reason-parity.test.mjs` proves it fires.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootFlag = process.argv.indexOf('--root');
const ROOT =
  rootFlag !== -1 && process.argv[rootFlag + 1]
    ? process.argv[rootFlag + 1]
    : join(dirname(fileURLToPath(import.meta.url)), '..');

const RUST_REL = 'rust/wasm-bindings/src/api/clash_solid.rs';
const TS_REL = 'apps/viewer/src/lib/clash/intersection-solid.ts';

/**
 * Every non-empty `reason` string literal the binding can assign, from its CODE
 * only. `#[cfg(test)]` and below is dropped: a reason named only in a Rust unit
 * test is not something the binding emits to JS.
 */
export function kernelReasons(rustSource) {
  const testMod = rustSource.indexOf('#[cfg(test)]');
  // Comments go FIRST, and all three forms of them: `/* … */` blocks, trailing
  // `//`, and full-line `//` (`//!` and `///` included, both being `//`-led).
  // Dropping only full-line comments left a false-GREEN: comment an arm OUT and
  // a comment-blind extractor still "finds" its literal, so the kernel set keeps
  // a reason the binding can no longer emit and the phantom check never fires.
  // Same naive strip the TS side uses below — symmetric by construction. No
  // string literal in the binding contains `//`, so nothing real is eaten; if a
  // future strip ever over-reached, the vacuity guard fails the check closed.
  const code = (testMod === -1 ? rustSource : rustSource.slice(0, testMod))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  const found = new Set();
  // `reason: "malformed-operand"` — the binding-level rejections.
  for (const m of code.matchAll(/reason:\s*"([a-z-]+)"/g)) found.add(m[1]);
  // `DegenerateReason::NoOverlap => ("no-overlap", …)` — the enum mapping,
  // including the braced `BelowKernelResolution { … } => (…)` arm.
  for (const m of code.matchAll(/DegenerateReason::\w+(?:\s*\{[^}]*\})?\s*=>\s*\(\s*"([a-z-]+)"/g)) {
    found.add(m[1]);
  }
  return found;
}

/** The union's members, read from the .ts SOURCE — a type is erased at runtime. */
export function declaredReasons(tsSource) {
  const code = tsSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const block = /export type ClashSolidDegenerateReason =([\s\S]*?);/.exec(code);
  if (!block) return new Set();
  return new Set([...block[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]));
}

/**
 * @returns {string[]} human-readable failures; empty means parity holds.
 */
export function checkParity(rustSource, tsSource) {
  const kernel = kernelReasons(rustSource);
  const declared = declaredReasons(tsSource);
  const failures = [];

  // Vacuity guard FIRST: an empty set makes every later comparison meaningless.
  if (kernel.size === 0) {
    failures.push(
      `no reason strings extracted from ${RUST_REL} — the extractor has drifted from the Rust source`,
    );
  }
  if (declared.size === 0) {
    failures.push(
      `no members extracted from ClashSolidDegenerateReason in ${TS_REL} — the extractor has drifted from the TS source`,
    );
  }
  if (failures.length > 0) return failures;

  const missing = [...kernel].filter((r) => !declared.has(r)).sort();
  const phantom = [...declared].filter((r) => !kernel.has(r)).sort();
  if (missing.length > 0) {
    failures.push(
      `the kernel can emit ${missing.map((r) => `'${r}'`).join(', ')} but ClashSolidDegenerateReason does not declare it`,
    );
  }
  if (phantom.length > 0) {
    failures.push(
      `ClashSolidDegenerateReason declares ${phantom.map((r) => `'${r}'`).join(', ')} but the kernel can never emit it`,
    );
  }
  return failures;
}

// Only run the gate when invoked as a script; the self-test imports the helpers.
if (process.argv[1] && process.argv[1].endsWith('check-clash-degenerate-reason-parity.mjs')) {
  // Fail closed: a renamed or moved file must break this check rather than
  // silently reduce it to zero comparisons.
  const rustSource = readFileSync(join(ROOT, RUST_REL), 'utf8');
  const tsSource = readFileSync(join(ROOT, TS_REL), 'utf8');
  const failures = checkParity(rustSource, tsSource);

  if (failures.length > 0) {
    console.error('\nClashSolidDegenerateReason has drifted from clash_solid.rs:\n');
    for (const f of failures) console.error(`  ${f}`);
    console.error(`
The reason crosses the wasm boundary as an untyped string and is cast on
arrival, so TypeScript cannot catch this. Update the union in
${TS_REL}
to match ${RUST_REL} exactly, in both directions.
`);
    process.exit(1);
  }

  const n = kernelReasons(rustSource).size;
  console.log(`check-clash-degenerate-reason-parity: OK (${n} reasons, TS union and Rust binding agree)`);
}
