/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { planRuns } from './revert-oracle-plan-runs.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// Each module puts one lexical shape ahead of its `mod tests;` declaration.
// A scan that misreads the shape masks source up to a later quote and the
// declaration disappears. Planning only reads source, so nothing is compiled.
const shapes = {
  // '"' taken for a string opener (the rust/export/src/step_slot.rs shape).
  quote_char: `pub fn is_quote(c: char) -> bool { c == '"' }\n`,
  // A byte char: the leading b must not stop the char literal being seen.
  quote_byte: `pub fn is_quote(c: u8) -> bool { c == b'"' }\n`,
  // Escaped quotes: a scan without escapes stops at the backslash.
  escaped_quote: `pub fn is_quote(c: char) -> bool { c == '\\"' || c == '\\u{22}' }\n`,
  // An escaped apostrophe read as the char '\' leaves a stray ' that pairs
  // with the following ,' into a char literal and exposes the " after it.
  escaped_apostrophe: `pub const QUOTES: [char; 2] = ['\\'','"'];\n`,
  // Lifetimes and a label are not char literals: pairing quotes instead
  // swallows from the third one through the declaration to the 'x' below.
  lifetimes: `pub struct Borrow<'a>(pub &'a str);\npub fn label(_: &'static str) { 'outer: loop { break 'outer; } }\n`,
};

test('#4723: a module declared after a Rust char literal is attributed to its lib target', () => {
  const root = mkdtempSync(join(tmpdir(), 'oracle-rust-char-literal-'));
  try {
    const names = Object.keys(shapes);
    writeFileSync(join(root, 'Cargo.toml'), '[package]\nname = "oracle-rust-char"\nversion = "0.1.0"\nedition = "2021"\n');
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/lib.rs'), names.map((name) => `pub mod ${name};\n`).join(''));
    for (const [name, shape] of Object.entries(shapes)) {
      writeFileSync(join(root, 'src', `${name}.rs`), `${shape}#[cfg(test)]\n#[path = "${name}_tests.rs"]\nmod tests;\npub const AFTER: char = 'x';\n`);
      writeFileSync(join(root, 'src', `${name}_tests.rs`), '#[test]\nfn runs() {}\n');
    }
    const files = names.map((name) => `src/${name}_tests.rs`);
    const { plans, unassigned } = planRuns(files, root);
    assert.deepEqual(unassigned, []);
    assert.deepEqual(plans.map((plan) => [plan.file, plan.moduleFilter]), names.map((name) => [`src/${name}_tests.rs`, `${name}::tests`]));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('#4723: repo module tests declared after a quote char literal are attributed', () => {
  const { plans, unassigned } = planRuns(['rust/export/src/step_slot_tests.rs', 'rust/core/src/parser/tokenizer_tests.rs'], repoRoot);
  assert.deepEqual(unassigned, []);
  assert.deepEqual(plans.map((plan) => [plan.moduleFilter, plan.runner.args.slice(3, 5)]), [
    ['step_slot::tests', ['ifc-lite-export', '--lib']],
    ['parser::tokenizer::tokenizer_tests', ['ifc-lite-core', '--lib']],
  ]);
});
