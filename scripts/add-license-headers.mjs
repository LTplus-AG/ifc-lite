#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * MPL-2.0 header on every source file (AGENTS.md, "New source files").
 *
 * Two modes over the same population:
 *   node scripts/add-license-headers.mjs           writes the missing headers
 *   node scripts/add-license-headers.mjs --check   reports them, writes nothing
 *
 * `--check` is the gate, and until #4087 NOTHING RAN IT. A mode nobody
 * invokes cannot be wrong loudly, so it drifted: it exited 1 with 128 files
 * flagged, 85 of which were correctly licensed under an SPDX identifier it
 * did not recognise, 16 were generated output that wants exclusion rather
 * than a header, and its scan list covered four trees out of eleven. It now
 * runs in the `license-headers` job of .github/workflows/test.yml, whose
 * `license_headers` path filter is the whole scanned population so the gate
 * can fire on every tree it reads.
 *
 * Classification (which files are in scope, what counts as a declaration) is
 * `scripts/lib/license-header.mjs`; this file owns the scan, the CLI and the
 * reporting.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

import {
    licenseHeaderFor,
    hasLicenseHeader,
    withLicenseHeader,
    LICENSE_HEADERS,
    EXCLUDED_DIRS,
} from './lib/license-header.mjs';
import { isMainEntry } from './lib/is-main-entry.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

// Which files must carry a header, which spellings count as one, and which
// generated trees are exempt all live in `scripts/lib/license-header.mjs`.
// The split is a module boundary, not a workaround: the lib is a pure
// classifier over a path and a string, and this file is the I/O around it —
// the scan, the CLI, the report, the writes. Everything below the
// `isMainEntry` guard is that outer half, so the two can be read, changed and
// tested without each other. `scripts/lib/license-header.test.mjs` exercises
// the classifier directly; the CLI's behaviour is exercised by running it.

// Repo-relative path, which is the form the classification lib speaks.
function repoRelative(filePath) {
    return relative(rootDir, filePath);
}

// THREE outcomes, not two. A boolean folded "I wrote a header", "nothing to
// do here" and "I could not read/write this file" into false-or-true, so the
// write loop counted an I/O failure as a skip: the run printed `Error writing
// ...` on stderr, then `Errors: 0`, then exited 0. That is the same false-pass
// shape --check spends a distinct exit code 2 avoiding, on the mode that
// actually mutates files. Callers must be able to tell the third case apart,
// so it is in the return type.
const ADDED = 'added';
const SKIPPED = 'skipped';
const FAILED = 'failed';

function addLicenseHeader(filePath) {
    const rel = repoRelative(filePath);
    if (licenseHeaderFor(rel) === null) {
        return SKIPPED;
    }

    let content;
    try {
        content = readFileSync(filePath, 'utf-8');
    } catch (error) {
        console.error(`Error reading ${filePath}:`, error.message);
        return FAILED;
    }

    const updated = withLicenseHeader(rel, content);
    if (updated === null) {
        return SKIPPED; // already declares MPL-2.0
    }

    try {
        writeFileSync(filePath, updated, 'utf-8');
        return ADDED;
    } catch (error) {
        console.error(`Error writing ${filePath}:`, error.message);
        return FAILED;
    }
}

// The scan-root entry that means "the repository root itself". `findFiles`
// scans it non-recursively; see the comment on the `find` command below.
const REPO_ROOT = '.';

// Returns { files, missingRoots }. A missing scan root used to be a
// console.warn that the caller could scroll past — the scan would silently
// continue over whatever roots DID exist, "Found 0 files to process"
// would print same as a real clean scan, and --check would exit 0 having
// verified nothing. Callers now decide what to do with missingRoots; both
// the --check and default paths below treat it as fatal (see the "loudly"
// comment further down).
function findFiles(scanRoots, extensions) {
    const files = [];
    const missingRoots = [];

    for (const dir of scanRoots) {
        const fullPath = join(rootDir, dir);
        if (!existsSync(fullPath)) {
            missingRoots.push(fullPath);
            continue;
        }

        // Use find command to get all files with specified extensions.
        // The directory exclusions are `EXCLUDED_DIRS`, not a second spelling
        // of it: `licenseHeaderFor` re-checks them downstream, so a divergence
        // here would not be a correctness bug — it would be a silent cost,
        // `find` walking a tree whose every hit is then discarded.
        //
        // The repo root is the one root scanned NON-recursively. Every other
        // root is a subtree of it, so a recursive walk here would re-walk all
        // of them, double-count every file, and drag in `node_modules`,
        // `target` and every other build directory besides. `-maxdepth 1` is
        // placed before `-type f` because BSD `find` (macOS) rejects it as an
        // option after a primary, while GNU `find` accepts either.
        const depthLimit = dir === REPO_ROOT ? '-maxdepth 1 ' : '';
        const extPattern = extensions.map(ext => `-name "*.${ext}"`).join(' -o ');
        const prunePattern = EXCLUDED_DIRS.map(dir => `! -path "*/${dir}/*"`).join(' ');
        const findCmd = `find "${fullPath}" ${depthLimit}-type f \\( ${extPattern} \\) ${prunePattern}`;

        try {
            const output = execSync(findCmd, { encoding: 'utf-8', cwd: rootDir });
            const foundFiles = output.trim().split('\n').filter(f => f);
            files.push(...foundFiles);
        } catch (error) {
            // find command may return non-zero if no files found, which is okay
            if (error.status !== 1) {
                console.error(`Error finding files in ${dir}:`, error.message);
            }
        }
    }

    return { files, missingRoots };
}

// Everything below runs only when this file is what node was asked to run.
// Without the guard, importing this module — a test, a tool, an editor's
// module graph — would scan the repo and, in the default mode, WRITE to every
// file missing a header. `scripts/lib/is-main-entry.mjs` is the repo's
// standard answer to that — it has its own test and callers throughout
// `scripts/` — so this file uses it rather than relying on nobody importing
// it. The classification lib next door is a module boundary, not a substitute
// for this guard.
//
// The CLI is a FUNCTION and every branch `return`s after setting
// `process.exitCode`, never `process.exit()`. `process.exit()` tears the
// process down without draining stdout, and stdout is a PIPE in CI: writes
// there are asynchronous, so a long "missing the MPL license header" list can
// be cut off mid-path while the status still says 1. That list IS this gate's
// output. Setting `exitCode` and returning lets node flush both streams and
// leave with the same status.
function main() {
    // --- CLI flags ---------------------------------------------------------
    // Unknown flags are a hard error, not a silent no-op: this script used to
    // ignore any flag it didn't recognize and fall straight through to the
    // default (write) behavior below, so a typo'd or not-yet-implemented flag
    // (e.g. `--check` before this mode existed) would silently rewrite every
    // source file in the repo instead of doing what the caller asked.
    const KNOWN_FLAGS = new Set(['--check']);
    const argv = process.argv.slice(2);
    for (const arg of argv) {
        if (!KNOWN_FLAGS.has(arg)) {
            console.error(`Unknown flag: ${arg}`);
            console.error(`Known flags: ${[...KNOWN_FLAGS].join(', ')} (or no flags at all)`);
            process.exitCode = 1;
            return;
        }
    }
    const checkMode = argv.includes('--check');

    // Main execution
    //
    // `prototype/src` was removed here (not in the `scanRoots` list below): it
    // hasn't existed in the repo since the initial-structure commit, but the
    // missing-root check used to be a console.warn the write path quietly
    // continued past, so this went unnoticed until the check above started
    // treating it as fatal — exactly the kind of drift the missing-root check
    // exists to catch.
    //
    // EVERY first-party source tree, not a subset (#4087). The old list was
    // `apps/viewer/src`, `packages`, `rust`, `tests`, which left `apps/server`,
    // `apps/viewer-embed`, `apps/landing`, everything in `apps/viewer` outside
    // `src/` (its vite config and plugins), `examples`, `docs`, `api`, `server`,
    // `scripts` and `tools` unscanned — 12 headerless files at the time this
    // list was widened, and no signal at all that they were out of scope. The
    // derivation is "every top-level directory that holds first-party source of
    // a type in `LICENSE_HEADERS`, plus the repo root itself". Re-derived
    // when `.mjs`/`.cjs`/`.mts`/`.cts`/`.py` joined that table, because a root
    // list and an extension list are only right TOGETHER: `demo/` (one shell
    // script) and `patches/` (patch files) still hold nothing of any scanned
    // type and stay out rather than being listed as no-ops.
    //
    // `REPO_ROOT` replaced a single NAMED root-level file. Naming one file made
    // the root a list of one nobody would think to extend: a PR adding a second
    // root-level config of a scanned type got no header check at all, which is
    // the requirement this gate exists for. The root is scanned by EXTENSION
    // like every other root, non-recursively so it does not re-walk the ten
    // below it. It matches exactly the one file the named entry matched, so it
    // widens what the gate catches tomorrow and moves nothing today.
    //
    // `.changeset/changelog-resilient.cjs` is the one file of a scanned type
    // that no root reaches (`-maxdepth 1` does not descend into it); adding
    // `.changeset` here would put release machinery inside a source-header gate
    // for one file, so it is left alone knowingly rather than by omission.
    //
    // Adding a root that does not exist is a hard exit 2, below, so entries here
    // are checked rather than assumed.
    const scanRoots = [
        REPO_ROOT,
        'api',
        'apps',
        'docs',
        'examples',
        'packages',
        'rust',
        'scripts',
        'server',
        'tests',
        'tools',
    ];

    // DERIVED from the classifier, never restated. `findFiles` only hands
    // `licenseHeaderFor` the files whose extension is in this list, so a second
    // copy drifts in the direction that says nothing: add a key to
    // `LICENSE_HEADERS` without editing the copy and those files are never
    // surfaced, the classifier never runs on them, and `--check` reports a clean
    // repo it did not look at. Deriving it makes that impossible rather than
    // merely unlikely.
    const extensions = Object.keys(LICENSE_HEADERS);

    console.log('Finding source files...');
    const { files, missingRoots } = findFiles(scanRoots, extensions);

    // A missing scan root means this script's assumptions about the repo
    // layout are stale (wrong cwd, a renamed/moved directory, a restructured
    // `packages/`, ...). Silently scanning whatever subset of roots DID
    // exist — possibly zero of them — and reporting that as a normal result is
    // exactly the false-pass failure mode this script must not have: --check
    // exiting 0 having verified nothing, or the default path "adding headers"
    // to nothing while believing it covered the repo. Fatal in BOTH modes,
    // deliberately, not just --check: a partial write is just as misleading as
    // a partial check, it's only less visible because nothing consumes its
    // exit code today.
    if (missingRoots.length > 0) {
        console.error(`\n❌ Expected scan root${missingRoots.length === 1 ? '' : 's'} not found:`);
        for (const dir of missingRoots) {
            console.error(`  ${dir}`);
        }
        console.error(
            `\nThis script resolves its scan roots relative to its own location (${rootDir}).\n` +
            'Run it from within the repo, or update the `scanRoots` list above if the repo layout\n' +
            'changed. Refusing to run against a partial/wrong set of roots.'
        );
        process.exitCode = 2;
        return;
    }

    console.log(`Found ${files.length} files to process`);

    if (checkMode) {
        // Zero files scanned is not a clean repo — it's a check that verified
        // nothing, and reporting success for it would be the same false-pass
        // bug as the missing-root case above, just triggered a different
        // way (e.g. the extensions list stops matching anything). Distinct exit
        // code AND distinct wording from "files are missing headers" below:
        // this is "the check could not run", not "the check ran and found a
        // problem to fix".
        if (files.length === 0) {
            console.error(
                '\n❌ --check scanned 0 files. That is a failed check, not a clean repo — ' +
                'refusing to report success for a check that verified nothing.'
            );
            process.exitCode = 2;
            return;
        }

        // Dry run: report files missing the header, write nothing, and fail CI
        // if any are found.
        const missing = [];
        // A file that fails to read (permissions, a race with a deleting process,
        // a broken symlink, ...) was previously `continue`d past silently: not
        // added to `missing`, not counted in `excluded` either, so it still
        // landed in the `files.length - excluded` "Checked" total below and the
        // run could print "All files have the license header" having actually
        // never looked at that file's content — the same false-pass class as the
        // zero-files-scanned case above, just one file at a time instead of the
        // whole scan. Track it separately and fail loudly instead.
        const readErrors = [];
        let excluded = 0;

        for (const file of files) {
            if (licenseHeaderFor(repoRelative(file)) === null) {
                excluded++;
                continue;
            }

            let content;
            try {
                content = readFileSync(file, 'utf-8');
            } catch (error) {
                console.error(`Error reading ${file}:`, error.message);
                readErrors.push(file);
                continue;
            }

            if (!hasLicenseHeader(content)) {
                missing.push(file);
            }
        }

        console.log(`\nResults:`);
        console.log(`  Checked: ${files.length - excluded - readErrors.length}`);
        console.log(`  Excluded: ${excluded}`);
        console.log(`  Unreadable: ${readErrors.length}`);
        console.log(`  Missing header: ${missing.length}`);

        if (readErrors.length > 0) {
            console.error(
                `\n❌ ${readErrors.length} file(s) could not be read, so their license header could not be ` +
                'verified. That is a failed check, not a clean repo — refusing to report success for a check ' +
                `that did not actually look at ${readErrors.length === 1 ? 'this file' : 'these files'}.`
            );
            process.exitCode = 2;
            return;
        }

        if (missing.length > 0) {
            console.log(`\nFiles missing the MPL license header:`);
            for (const file of missing) {
                console.log(`  ${file}`);
            }
            console.log(`\n❌ ${missing.length} file(s) missing the license header. Run without --check to add them.`);
            process.exitCode = 1;
            return;
        }

        console.log(`\n✅ All files have the license header.`);
        process.exitCode = 0;
        return;
    }

    let added = 0;
    let skipped = 0;
    const failures = [];

    for (const file of files) {
        const outcome = addLicenseHeader(file);
        if (outcome === ADDED) added++;
        else if (outcome === SKIPPED) skipped++;
        else failures.push(file);
    }

    console.log(`\nResults:`);
    console.log(`  Added headers: ${added}`);
    console.log(`  Skipped (already have header or excluded): ${skipped}`);
    console.log(`  Errors: ${failures.length}`);

    // Same verdict --check gives an unreadable file, on the mode that writes:
    // a file this run could not read or could not write does NOT have a
    // header, and reporting `Errors: 0` and exiting 0 over it would be the
    // false pass this script exists to stop. `errors` used to be a `let` that
    // nothing ever incremented, so that is exactly what it did.
    if (failures.length > 0) {
        console.error(
            `\n❌ ${failures.length} file(s) could not be read or written, so their license header ` +
            'was not added. That is a failed run, not a clean repo — refusing to report success for ' +
            `${failures.length === 1 ? 'a file' : 'files'} this run did not actually header.`
        );
        for (const file of failures) {
            console.error(`  ${file}`);
        }
        process.exitCode = 2;
        return;
    }

    console.log(`\nDone!`);
}

if (isMainEntry(import.meta.url)) {
    main();
}
