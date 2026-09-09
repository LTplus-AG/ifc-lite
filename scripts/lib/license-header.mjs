/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What counts as an MPL-2.0 declaration, and which files have to carry one.
 *
 * This is the classification half of `scripts/add-license-headers.mjs`. The
 * split is a module boundary: everything here is a pure function of a path
 * and a string, while the script next door owns the scan, the CLI, the report
 * and the writes. Nothing here touches the filesystem — callers hand it a
 * repo-relative path and, where relevant, the file's contents — which is what
 * lets `license-header.test.mjs` exercise the rules themselves at unit speed,
 * with no repo to walk and nothing to undo afterwards.
 *
 * The rule the whole gate turns on (#4087): TWO spellings declare MPL-2.0 and
 * both are in this tree — the prose notice `add-license-headers.mjs` writes,
 * and the one-line SPDX identifier that `rust/export` uses throughout.
 * Matching only the prose form is what kept `--check` unusable: it reported
 * 85 correctly-licensed SPDX files as missing a header, and the write path
 * would have stacked a prose header on top of a valid SPDX line in every one
 * of them. Keep the two spellings together HERE; a second copy of either
 * regex elsewhere is how they silently diverge again.
 */

/**
 * The notice itself, once. Every accepted header is this text in one comment
 * syntax or another, so it lives here as data rather than as one transcription
 * per extension. Ten copies of the same three lines can drift a word apart
 * while every one of them still looks right in isolation, and the gate's whole
 * job is that this wording is the same everywhere.
 */
const NOTICE = [
    'This Source Code Form is subject to the terms of the Mozilla Public',
    'License, v. 2.0. If a copy of the MPL was not distributed with this',
    'file, You can obtain one at https://mozilla.org/MPL/2.0/.',
];

/** C-family block comment: `/* … *\/`. */
function blockComment(notice) {
    return `/* ${notice.join('\n * ')} */\n`;
}

/** One comment line per notice line, behind `marker`. */
function lineComment(marker, notice) {
    return notice.map(line => `${marker} ${line}`).join('\n') + '\n';
}

const BLOCK = blockComment(NOTICE);
const SLASH_LINES = lineComment('//', NOTICE);
const HASH_LINES = lineComment('#', NOTICE);

/**
 * License headers by file extension. The KEYS are the scan population:
 * `scripts/add-license-headers.mjs` derives its `find` extension list from
 * them, so a type added here is scanned from that moment, and a type absent
 * here is a type this repo does not header.
 *
 * `.mjs`/`.cjs`/`.mts`/`.cts` and `.py` are here because leaving them out was
 * the same defect as the four-tree scan list this gate already fixed, one
 * level down: the roots said `scripts/` and `tools/` while the extensions said
 * `.ts`, so the gate read 13 of `scripts/`'s 312 code files, `tools/` was a
 * scan root that matched nothing at all, and `scripts/lib/license-header.mjs`
 * — this file, where the gate's own classification lives — was not checked by
 * the gate. The convention was never in doubt, only the enforcement: 334 of
 * the repo's 343 `.mjs`/`.cjs`/`.mts`/`.cts` files and all 13 of its `.py`
 * files already carried a header, so widening the table cost 8 prepends and
 * zero argument.
 */
export const LICENSE_HEADERS = {
    ts: BLOCK,
    tsx: BLOCK,
    js: BLOCK,
    mjs: BLOCK,
    cjs: BLOCK,
    mts: BLOCK,
    cts: BLOCK,
    css: BLOCK,
    rs: SLASH_LINES,
    // Derived from what the 13 tracked `.py` files already use, byte for
    // byte, not invented here: all 13 agree on this exact `#` form.
    py: HASH_LINES,
};

/** Directory NAMES excluded wherever they appear in a path. */
export const EXCLUDED_DIRS = ['node_modules', 'dist', 'target'];

/**
 * Generated output: never headered, because a header here is either discarded
 * by the next regeneration or actively breaks a freshness gate. A trailing
 * `/` makes an entry a directory prefix; anything else is an exact
 * repo-relative path.
 *
 * (The three entries this replaced — `packages/wasm/ifc_lite_wasm.js`,
 * `.d.ts`, `_bg.wasm.d.ts` — named a layout wasm-pack stopped producing, so
 * they had excluded nothing for as long as the current `pkg/` layout has
 * existed. Directory prefixes are used here so the list cannot go stale one
 * filename at a time the same way.)
 */
export const EXCLUDED_PATHS = [
    // wasm-pack output. Only `pkg/ifc-lite.d.ts` is committed (force-added
    // past wasm-pack's own `pkg/.gitignore`); the rest is gitignored build
    // product that `scripts/build-wasm.sh` leaves on disk, and `find` walks
    // it anyway because it is neither `dist/` nor `target/`.
    //
    // ALL FIVE wasm-pack out-dirs under a scan root, not the two that happen
    // to be built by default. CI builds none of them, so a partial list is
    // invisible there and only bites a developer who ran the build: `--check`
    // then lists generated files as missing a header, and the write path
    // stamps MPL notices into wasm-pack's output. Each path is the `--out-dir`
    // its build script passes, read off the script rather than guessed —
    // `scripts/build-wasm.sh:84` (`pkg`), `:140` (`pkg-threaded`), `:208`
    // (`pkg-wide`, behind `BUILD_WIDE=1`), and `rust/csg-thread-bench/build.sh`
    // `:20`/`:21`, whose `web/pkg-plain` and `web/pkg-threaded` are relative to
    // the script's own directory (it `cd`s there on line 19).
    'packages/wasm/pkg/',
    'packages/wasm/pkg-threaded/',
    'packages/wasm/pkg-wide/',
    'rust/csg-thread-bench/web/pkg-plain/',
    'rust/csg-thread-bench/web/pkg-threaded/',
    // EXPRESS-schema codegen output. `scripts/check-codegen-sync.mjs`
    // BYTE-COMPARES these against a fresh run of the real generator, so a
    // header prepended here is not merely pointless — it fails that gate.
    // The generators are `packages/codegen`'s `generate:ifc4` /
    // `generate:ifc4x3`, plus the parser's committed mirror of the IFC4 half
    // (`packages/codegen/INTEGRATION.md`). Measured while excluding these:
    // those templates emit the MPL header on 4 of their 9 outputs each
    // (index, serializers, test-compile, type-ids) and omit it on the other
    // 5 (entities, enums, schema-registry, selects, types). Excluding the
    // tree freezes that inconsistency rather than fixing it — the fix is in
    // the codegen TEMPLATES plus a regeneration, which is a different change
    // from this one and is not attempted here.
    'packages/codegen/generated/',
    'packages/parser/src/generated/',
    // NOT excluded, deliberately: `packages/data/src/ifc-schema/generated/`
    // is byte-compared by that same gate, but ITS generator writes the MPL
    // header into every file it emits, so those files already pass and need
    // no exemption. An exemption would only hide it if that ever stopped.
];

const MPL_PROSE_RE = /This Source Code Form is subject to the terms of the Mozilla Public/i;
const MPL_SPDX_RE = /SPDX-License-Identifier:\s*MPL-2\.0/i;

/**
 * How many leading lines count as "the header".
 *
 * MEASURED, not picked: across the 5318 in-scope files, the deepest a real
 * header starts is line 8 (`scripts/test-geometry-regression.mjs` and
 * `-reference.mjs`, whose notice sits at the end of a leading doc comment),
 * while the shallowest occurrence that is EMITTED DATA rather than a header is
 * line 18 (`packages/codegen/src/type-ids-generator.ts`, inside a template
 * literal). 10 is between the two: every file accepted today is still
 * accepted, and the nearest false accept is 8 lines out of reach.
 */
const HEADER_SCAN_LINES = 10;

/** The first `HEADER_SCAN_LINES` lines of `content`, or all of it if shorter. */
function leadingLines(content) {
    let end = 0;
    for (let n = 0; n < HEADER_SCAN_LINES; n++) {
        const next = content.indexOf('\n', end);
        if (next === -1) return content;
        end = next + 1;
    }
    return content.slice(0, end);
}

/**
 * Does this file already declare MPL-2.0, in either accepted spelling, AT THE
 * TOP?
 *
 * Scoped to the leading lines rather than the whole text, because the whole
 * text says yes to a file whose only occurrence of the notice is emitted DATA
 * — a template literal, a fixture string, a docstring. `packages/codegen/src`
 * holds 4 such files today (`generator.ts:118`, `serialization-generator.ts:22`,
 * `type-ids-generator.ts:18`, `rust-generator.ts:40`), and every one of them
 * also carries a real header on line 1, so nothing in the repo relies on the
 * late match. A NEW sibling generator without a top header would have been
 * waved through by the gate meant to catch exactly that.
 *
 * @param {string} content the file's text; only its first 10 lines are read
 * @returns {boolean}
 */
export function hasLicenseHeader(content) {
    const head = leadingLines(content);
    return MPL_PROSE_RE.test(head) || MPL_SPDX_RE.test(head);
}

function extensionOf(relativePath) {
    const base = relativePath.slice(relativePath.lastIndexOf('/') + 1);
    const dot = base.lastIndexOf('.');
    return dot > -1 ? base.slice(dot + 1) : null;
}

/**
 * The header this file would have to carry, or `null` when the file is out of
 * scope — a type this repo does not header, or generated/vendored output.
 *
 * Both the `--check` loop and the write path go through this one function, so
 * they cannot drift on what counts as "a file this script cares about".
 *
 * @param {string} relativePath repo-relative, `/`-separated (or Windows `\`)
 * @returns {string | null}
 */
export function licenseHeaderFor(relativePath) {
    const normalized = relativePath.replace(/\\/g, '/');

    const ext = extensionOf(normalized);
    if (!ext || !Object.hasOwn(LICENSE_HEADERS, ext)) return null;

    // Match whole path SEGMENTS, so a directory called `distribution` is not
    // swallowed by the `dist` entry.
    const segments = normalized.split('/');
    if (segments.some(segment => EXCLUDED_DIRS.includes(segment))) return null;

    // Anchored (prefix for a directory entry, equality for a file) rather
    // than a substring test: a substring test would also exclude
    // `vendor/packages/wasm/pkg/x.ts`, and an exclusion that matches more
    // than it names is how a header gate goes quiet without saying so.
    const excluded = EXCLUDED_PATHS.some(entry =>
        entry.endsWith('/') ? normalized.startsWith(entry) : normalized === entry);
    if (excluded) return null;

    return LICENSE_HEADERS[ext];
}

/**
 * File types where a leading `#!` is a shebang, so the header goes UNDER it.
 *
 * The gate is the EXTENSION, not the two bytes, because `#!` at the start of a
 * file means two different things in this repo. In the JS/TS family and in
 * Python it can only be a hashbang (or, in Python, an ordinary comment — which
 * is harmless to push down); in Rust `#![...]` is an INNER ATTRIBUTE, and
 * `rust/core/fuzz/fuzz_targets/parse_entity.rs` opens with `#![no_main]`.
 * Keying on `content.startsWith('#!')` therefore wrote that file's header on
 * line 2, contradicting both `LICENSE_HEADER.md` ("first line of the file")
 * and the copy this very change commits, so stripping the header and re-running
 * write mode produced a DIFFERENT file. On a multi-line attribute
 * (`#![cfg_attr(\n  feature = "nightly",\n  ...)]`) it spliced the three
 * comment lines between `#![cfg_attr(` and the rest of the token tree; that
 * still compiles, since Rust comments are trivia, but it is not the header
 * anyone asked for and it is not on line 1.
 *
 * Chosen over sharpening the test to `#!/`: the question "is `#!` a shebang
 * here" is a property of the LANGUAGE, so the file type is what should answer
 * it, and phrasing it that way keeps working for the shebang spellings a `#!/`
 * test would miss (`#! /usr/bin/env node`, `#!python3`). `.css` is absent for
 * the same reason `.rs` is — `#!` is not a shebang there either. A type added
 * to `LICENSE_HEADERS` and not considered here gets the safe answer, a header
 * on line 1, which is what every non-shebang file in the repo already has.
 */
const SHEBANG_EXTENSIONS = new Set(['js', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts', 'py']);

/**
 * The file's contents with a header inserted, or `null` when nothing should
 * be written — the file is out of scope, or it already declares MPL-2.0.
 *
 * A shebang line stays FIRST. `#!` is only a comment when it is the first two
 * bytes of the file: push it down and an `.mjs` file stops parsing at all
 * (`SyntaxError`), a `.py` one stops being executable, and the header that
 * was supposed to be a no-op edit has broken the program. Every in-scope file
 * in this repo that carries both already orders them this way — shebang, then
 * notice — so this is the existing convention, expressed once.
 *
 * This mattered the moment `.mjs`/`.cjs`/`.py` joined `LICENSE_HEADERS`: of
 * the 8 files the widened gate found headerless, 5 begin with a shebang.
 * Before that, the write path had never met one, which is the only reason a
 * plain prepend had been correct.
 *
 * @param {string} relativePath repo-relative path
 * @param {string} content the file's current text
 * @returns {string | null}
 */
export function withLicenseHeader(relativePath, content) {
    const header = licenseHeaderFor(relativePath);
    if (header === null) return null;
    if (hasLicenseHeader(content)) return null;

    const ext = extensionOf(relativePath.replace(/\\/g, '/'));
    const shebangLine = SHEBANG_EXTENSIONS.has(ext) && content.startsWith('#!');
    if (!shebangLine) return header + '\n' + content;

    const lineEnd = content.indexOf('\n');
    const shebang = lineEnd === -1 ? content + '\n' : content.slice(0, lineEnd + 1);
    const rest = lineEnd === -1 ? '' : content.slice(lineEnd + 1);
    return shebang + header + '\n' + rest;
}
