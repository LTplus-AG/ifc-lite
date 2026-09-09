#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The two accepted spellings of an MPL-2.0 declaration, and the exclusions
 * that keep generated output out of the gate's population.
 *
 * THE DEFECT PINNED HERE (#4087). `hasLicenseHeader` matched only the PROSE
 * notice, so 85 files carrying `// SPDX-License-Identifier: MPL-2.0` — a
 * valid MPL-2.0 declaration, 84 of them in `rust/export` — read as
 * unlicensed. `--check` therefore exited 1 on a correctly-licensed tree and
 * could never be turned on, and the write path would have stacked a prose
 * header on top of a valid SPDX line in every one of those files. The two
 * forms are asserted here in BOTH directions so they cannot silently
 * diverge again: each is accepted, and a file with neither is still
 * rejected — a detector that answered `true` unconditionally would satisfy
 * half of this file and fail the other half.
 *
 * The header-form cases read real files off disk rather than inline strings:
 * the bug was about what is in the repo's files, and a test that only ever
 * sees a literal cannot notice a reader that mangles them.
 *
 * Run: node --test scripts/lib/license-header.test.mjs
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  hasLicenseHeader,
  licenseHeaderFor,
  withLicenseHeader,
  LICENSE_HEADERS,
} from './license-header.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'license-header-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** Write `content` to a throwaway file and hand back what a reader sees. */
function fileWith(name, content) {
  const path = join(scratch, name);
  writeFileSync(path, content, 'utf-8');
  return readFileSync(path, 'utf-8');
}

const PROSE_FILE = `/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export const answer = 42;
`;

const SPDX_FILE = `// SPDX-License-Identifier: MPL-2.0

pub fn answer() -> u32 {
    42
}
`;

const UNLICENSED_FILE = `export const answer = 42;
`;

test('the prose notice counts as an MPL-2.0 declaration', () => {
  assert.equal(hasLicenseHeader(fileWith('prose.ts', PROSE_FILE)), true);
});

test('the SPDX identifier counts as an MPL-2.0 declaration (#4087)', () => {
  assert.equal(hasLicenseHeader(fileWith('spdx.rs', SPDX_FILE)), true);
});

test('a file with neither form is still reported as missing a header', () => {
  assert.equal(hasLicenseHeader(fileWith('bare.ts', UNLICENSED_FILE)), false);
});

test('an SPDX identifier for a DIFFERENT license is not an MPL-2.0 declaration', () => {
  assert.equal(hasLicenseHeader('// SPDX-License-Identifier: Apache-2.0\n'), false);
});

test('the notice buried DEEP in a file is not a header (#4087)', () => {
  // A generator that emits the notice as DATA — a template literal, a fixture
  // string, a docstring — used to satisfy the detector on the strength of that
  // occurrence alone, so a headerless new generator would be waved through by
  // the gate meant to catch it. `packages/codegen/src` has 4 files that embed
  // the notice this way (the shallowest at line 18); all 4 also carry a real
  // header on line 1, so this is a tightening with nothing behind it today.
  const generator = 'export function emit() {\n' +
    '  return `/* This Source Code Form is subject to the terms of the Mozilla Public\n' +
    ' * License, v. 2.0. If a copy of the MPL was not distributed with this\n' +
    ' * file, You can obtain one at https://mozilla.org/MPL/2.0/. */`;\n' +
    '}\n';
  const buried = '// line 1\n'.repeat(10) + generator;
  assert.equal(hasLicenseHeader(buried), false);
  // ...and the write path therefore gives it a real header.
  assert.equal(
    withLicenseHeader('packages/codegen/src/new-generator.ts', buried),
    LICENSE_HEADERS.ts + '\n' + buried,
  );

  // A file that both EMITS the notice and carries a real header is still fine.
  assert.equal(hasLicenseHeader(LICENSE_HEADERS.ts + '\n' + buried), true);
});

test('a header at the bottom of the leading comment block still counts', () => {
  // The deepest real header measured in this repo starts on line 8, at the end
  // of a leading doc comment (`scripts/test-geometry-regression.mjs`). Shrink
  // the window past that and the gate starts demanding a second header on
  // correctly-licensed files.
  const late = '#!/usr/bin/env node\n/**\n * Title\n *\n * Prose.\n *\n * More prose.\n' +
    ' * This Source Code Form is subject to the terms of the Mozilla Public\n' +
    ' * License, v. 2.0. If a copy of the MPL was not distributed with this\n' +
    ' * file, You can obtain one at https://mozilla.org/MPL/2.0/.\n */\n';
  assert.equal(late.split('\n').findIndex(l => /This Source Code Form/.test(l)) + 1, 8);
  assert.equal(hasLicenseHeader(late), true);
  assert.equal(withLicenseHeader('scripts/test-geometry-regression.mjs', late), null);
});

test('the write path leaves an SPDX-declared file untouched (#4087)', () => {
  // The 85-file regression in one assertion: before the fix this returned a
  // prose header stacked on top of the SPDX line.
  assert.equal(withLicenseHeader('rust/export/src/lib.rs', SPDX_FILE), null);
});

test('the write path prepends a header a re-check then accepts', () => {
  const updated = withLicenseHeader('packages/renderer/src/bvh.ts', UNLICENSED_FILE);
  assert.notEqual(updated, null);
  assert.equal(hasLicenseHeader(updated), true);
  assert.ok(updated.endsWith(UNLICENSED_FILE), 'original content must survive verbatim');
  assert.equal(withLicenseHeader('packages/renderer/src/bvh.ts', updated), null);
});

test('the comment syntax follows the file type', () => {
  assert.equal(licenseHeaderFor('packages/renderer/src/bvh.ts'), LICENSE_HEADERS.ts);
  assert.equal(licenseHeaderFor('rust/core/src/lib.rs'), LICENSE_HEADERS.rs);
  assert.ok(licenseHeaderFor('rust/core/src/lib.rs').startsWith('//'));
  assert.ok(licenseHeaderFor('packages/renderer/src/bvh.ts').startsWith('/*'));
});

test('a file type this repo does not header is out of scope', () => {
  assert.equal(licenseHeaderFor('docs/index.md'), null);
  assert.equal(licenseHeaderFor('Makefile'), null);
  assert.equal(licenseHeaderFor('docs/mkdocs.yml'), null);
  assert.equal(licenseHeaderFor('tools/ifcopenshell_reference/Dockerfile'), null);
});

test('generated output is excluded, and only where it actually lives', () => {
  assert.equal(licenseHeaderFor('packages/codegen/generated/ifc4/enums.ts'), null);
  assert.equal(licenseHeaderFor('packages/parser/src/generated/enums.ts'), null);
  assert.equal(licenseHeaderFor('packages/wasm/pkg/ifc-lite.d.ts'), null);

  // Hand-written siblings of each excluded tree stay in scope; an exclusion
  // that swallowed these would silence the gate over real source.
  assert.notEqual(licenseHeaderFor('packages/codegen/src/cli.ts'), null);
  assert.notEqual(licenseHeaderFor('packages/parser/src/columnar-parser.ts'), null);
  assert.notEqual(licenseHeaderFor('packages/wasm/src/index.ts'), null);
  // packages/data's generator emits the header itself, so its output is NOT
  // exempt here — see the note in license-header.mjs.
  assert.notEqual(licenseHeaderFor('packages/data/src/ifc-schema/generated/attributes.ts'), null);
});

test('exclusions are anchored, not substring matches', () => {
  // A substring test would have excluded both of these.
  assert.notEqual(licenseHeaderFor('vendor/packages/codegen/generated/x.ts'), null);
  assert.notEqual(licenseHeaderFor('packages/wasm/pkg-notes/x.ts'), null);
});

test('EVERY wasm-pack out-dir under a scan root is excluded, not just the default two', () => {
  // CI builds none of these, so a missing entry is invisible there and only
  // bites a developer who ran the build: `--check` lists generated files as
  // missing a header, and write mode stamps MPL notices into wasm-pack output.
  // Each path is the `--out-dir` its build script passes.
  // scripts/build-wasm.sh:208, behind BUILD_WIDE=1.
  assert.equal(licenseHeaderFor('packages/wasm/pkg-wide/ifc-lite.d.ts'), null);
  // rust/csg-thread-bench/build.sh:20-21, relative to the script's own dir.
  assert.equal(licenseHeaderFor('rust/csg-thread-bench/web/pkg-plain/csgbench.js'), null);
  assert.equal(licenseHeaderFor('rust/csg-thread-bench/web/pkg-threaded/csgbench.js'), null);

  // Hand-written siblings of the bench's generated trees stay in scope.
  assert.notEqual(licenseHeaderFor('rust/csg-thread-bench/web/serve.mjs'), null);
  assert.notEqual(licenseHeaderFor('rust/csg-thread-bench/src/lib.rs'), null);
});

test('excluded directory names match whole path segments', () => {
  assert.equal(licenseHeaderFor('packages/x/dist/index.js'), null);
  assert.equal(licenseHeaderFor('packages/x/node_modules/dep/index.js'), null);
  // `distribution` is not `dist`.
  assert.notEqual(licenseHeaderFor('packages/x/src/distribution/index.ts'), null);
});

test('Windows-style separators classify the same as POSIX ones', () => {
  assert.equal(licenseHeaderFor('packages\\codegen\\generated\\ifc4\\enums.ts'), null);
  assert.equal(licenseHeaderFor('packages\\renderer\\src\\bvh.ts'), LICENSE_HEADERS.ts);
});

// --- The extensions the gate actually reads (#4087 follow-up) --------------
//
// The roots said `scripts/` and `tools/` while the extensions said `.ts`, so
// the gate read 9 of `scripts/`'s ~306 code files, `tools/` was a scan root
// that matched nothing at all, and `license-header.mjs` itself was not
// checked. These cases pin the population by NAMING real files in the trees
// that were dark, so narrowing the table again reds a test instead of
// quietly shrinking what the gate looks at.

test('the script trees the gate reads are `.mjs`, not just `.ts` (#4087)', () => {
  assert.equal(licenseHeaderFor('scripts/check-module-size.mjs'), LICENSE_HEADERS.mjs);
  // The classifier this whole gate turns on has to be inside its own scope.
  assert.equal(licenseHeaderFor('scripts/lib/license-header.mjs'), LICENSE_HEADERS.mjs);
  assert.equal(licenseHeaderFor('tools/demo-kit/derive-variants.mts'), LICENSE_HEADERS.mts);
  assert.equal(licenseHeaderFor('packages/x/legacy.cjs'), LICENSE_HEADERS.cjs);
  assert.equal(licenseHeaderFor('packages/x/legacy.cts'), LICENSE_HEADERS.cts);
});

// CLASSIFICATION IS NOT COVERAGE, and this file can only test the first half.
// One headerless `.cjs` in the repo stays out of reach after the extensions
// widened: `.changeset/changelog-resilient.cjs`. The classifier says it would
// need a header; `add-license-headers.mjs`'s scan roots never walk
// `.changeset/`, so nothing ever asks. Left alone deliberately rather than
// fixed by adding a root, which would put changeset machinery inside a
// source-header gate and fire the job on nearly every PR. Not asserted here
// either: naming that path in this file makes it a derived INPUT of the
// license-headers job, and `check-ci-path-coverage.mjs` correctly reports
// that the job's trigger cannot reach it.

test('`tools/` is not a scan root that scans nothing (#4087)', () => {
  // Both file types that make `tools/` a non-empty root.
  assert.notEqual(licenseHeaderFor('tools/world-gym/oracle_validate.py'), null);
  assert.notEqual(licenseHeaderFor('tools/ifcopenshell_reference/compare.py'), null);
  assert.notEqual(licenseHeaderFor('tools/demo-kit/derive-variants.mts'), null);
});

test('Python gets the `#` comment form the repo already uses', () => {
  const header = licenseHeaderFor('rust/python/tests/test_bindings.py');
  assert.equal(header, LICENSE_HEADERS.py);
  // Byte-for-byte what all 13 tracked `.py` files carry today. A `//` or `/*`
  // header in a Python file is a syntax error, so the wrong wrapper here does
  // not merely look wrong, it breaks the file the write path touches.
  assert.equal(
    header,
    '# This Source Code Form is subject to the terms of the Mozilla Public\n' +
    '# License, v. 2.0. If a copy of the MPL was not distributed with this\n' +
    '# file, You can obtain one at https://mozilla.org/MPL/2.0/.\n',
  );
});

test('every extension uses exactly one of the two comment forms', () => {
  // One notice, wrapped; nothing in the table is a fifth transcription that
  // could drift a word away from the others.
  const block = LICENSE_HEADERS.ts;
  const slash = LICENSE_HEADERS.rs;
  const hash = LICENSE_HEADERS.py;
  assert.ok(block.startsWith('/*') && block.trimEnd().endsWith('*/'));
  assert.ok(slash.startsWith('//'));
  assert.ok(hash.startsWith('#'));
  for (const [ext, header] of Object.entries(LICENSE_HEADERS)) {
    assert.ok(
      header === block || header === slash || header === hash,
      `${ext} is neither the block, the // nor the # form`,
    );
    // The notice text itself, identical in all of them.
    assert.ok(hasLicenseHeader(header), `${ext}'s header must satisfy the detector`);
    assert.equal(header.split('\n').filter(Boolean).length, 3, `${ext} must be a 3-line notice`);
  }
});

test('a `#!` line stays first when the header goes in', () => {
  // `#!` is a shebang only as the first two bytes of the file. 5 of the 8
  // files the widened gate found headerless begin with one, and a header
  // prepended above it makes an `.mjs` file a SyntaxError.
  const script = '#!/usr/bin/env node\nconsole.log(1);\n';
  const updated = withLicenseHeader('scripts/fixtures/fetch-fixtures.mjs', script);
  assert.equal(updated, '#!/usr/bin/env node\n' + LICENSE_HEADERS.mjs + '\nconsole.log(1);\n');
  assert.equal(updated.split('\n')[0], '#!/usr/bin/env node', 'shebang must stay on line 1');
  assert.equal(hasLicenseHeader(updated), true);
  // Idempotent, same as the no-shebang path.
  assert.equal(withLicenseHeader('scripts/fixtures/fetch-fixtures.mjs', updated), null);
});

test('a `#!` line stays first in Python too', () => {
  const script = '#!/usr/bin/env python3\nprint(1)\n';
  const updated = withLicenseHeader('tools/world-gym/oracle_validate.py', script);
  assert.equal(updated, '#!/usr/bin/env python3\n' + LICENSE_HEADERS.py + '\nprint(1)\n');
});

test('a Rust INNER ATTRIBUTE is not a shebang, so the header still lands on line 1', () => {
  // `#!` opens a shebang in the JS/TS family and in Python, and an inner
  // attribute in Rust. Keying the branch on the two bytes wrote the header on
  // line 2 of `rust/core/fuzz/fuzz_targets/parse_entity.rs`, which this repo
  // commits with the header on line 1 — so stripping that file's header and
  // re-running write mode produced a DIFFERENT file, and `LICENSE_HEADER.md`
  // says "first line of the file".
  const attr = '#![no_main]\n\nuse libfuzzer_sys::fuzz_target;\n';
  const updated = withLicenseHeader('rust/core/fuzz/fuzz_targets/parse_entity.rs', attr);
  assert.equal(updated, LICENSE_HEADERS.rs + '\n' + attr);
  assert.equal(
    updated.split('\n')[0],
    '// This Source Code Form is subject to the terms of the Mozilla Public',
    'the header must start on line 1, above the inner attribute',
  );
});

test('a MULTI-LINE Rust inner attribute is not split open by the header', () => {
  // The two-byte test spliced the three comment lines between `#![cfg_attr(`
  // and the rest of the token tree. Rust treats comments as trivia so that
  // still compiled (verified with rustc), which is precisely why nothing
  // would have caught it.
  const attr = '#![cfg_attr(\n    feature = "nightly",\n    feature(portable_simd)\n)]\n\nuse core::simd;\n';
  const updated = withLicenseHeader('rust/core/src/lib.rs', attr);
  assert.equal(updated, LICENSE_HEADERS.rs + '\n' + attr);
  assert.ok(updated.includes(attr), 'the attribute must survive as one unbroken token tree');
});

test('a `#` that is not a shebang is not treated as one', () => {
  // A Python file opening with an ordinary comment gets the header FIRST,
  // the same as any other headerless file.
  const script = '# a plain comment\nprint(1)\n';
  const updated = withLicenseHeader('tools/world-gym/oracle_validate.py', script);
  assert.equal(updated, LICENSE_HEADERS.py + '\n# a plain comment\nprint(1)\n');
});

test('the write path prepends to each new type and a re-check accepts it', () => {
  for (const ext of ['mjs', 'cjs', 'mts', 'cts', 'py']) {
    const path = `tools/sample.${ext}`;
    const updated = withLicenseHeader(path, UNLICENSED_FILE);
    assert.notEqual(updated, null, `${ext} must be in scope`);
    assert.equal(hasLicenseHeader(updated), true, `${ext}'s written header must re-check clean`);
    assert.equal(updated, LICENSE_HEADERS[ext] + '\n' + UNLICENSED_FILE, `${ext}: wrong header or mangled body`);
    assert.equal(withLicenseHeader(path, updated), null, `${ext} must be idempotent`);
  }
});
