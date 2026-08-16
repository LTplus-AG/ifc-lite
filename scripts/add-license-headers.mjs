#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

// License headers by file type
const LICENSE_HEADERS = {
    ts: `/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
`,
    tsx: `/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
`,
    js: `/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
`,
    css: `/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
`,
    rs: `// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
`,
};

// Files to exclude (generated files)
const EXCLUDED_FILES = [
    'packages/wasm/ifc_lite_wasm.js',
    'packages/wasm/ifc_lite_wasm.d.ts',
    'packages/wasm/ifc_lite_wasm_bg.wasm.d.ts',
];

// Directories to exclude
const EXCLUDED_DIRS = ['node_modules', 'dist', 'target'];

function getFileExtension(filePath) {
    const parts = filePath.split('.');
    return parts.length > 1 ? parts[parts.length - 1] : null;
}

function shouldExclude(filePath) {
    // Check if file is in excluded directories
    for (const dir of EXCLUDED_DIRS) {
        if (filePath.includes(`/${dir}/`) || filePath.includes(`\\${dir}\\`)) {
            return true;
        }
    }

    // Check if file is in excluded files list
    const relativePath = filePath.replace(rootDir + '/', '').replace(rootDir + '\\', '');
    if (EXCLUDED_FILES.some(excluded => relativePath.includes(excluded))) {
        return true;
    }

    return false;
}

function hasLicenseHeader(content) {
    // Check if file already has the MPL license header
    const mplPattern = /This Source Code Form is subject to the terms of the Mozilla Public/i;
    return mplPattern.test(content);
}

// Shared by both the write path (addLicenseHeader) and the --check loop
// below, so the two can't drift on what counts as "a file this script cares
// about" — duplicating this in --check was itself the same class of bug as
// the flag-parsing footgun: two copies that quietly stop agreeing.
function isEligibleFile(filePath) {
    const ext = getFileExtension(filePath);
    if (!ext || !LICENSE_HEADERS[ext]) {
        return null; // Not a file type we handle
    }
    if (shouldExclude(filePath)) {
        return null; // File is excluded
    }
    return ext;
}

function addLicenseHeader(filePath) {
    const ext = isEligibleFile(filePath);
    if (!ext) {
        return false;
    }

    let content;
    try {
        content = readFileSync(filePath, 'utf-8');
    } catch (error) {
        console.error(`Error reading ${filePath}:`, error.message);
        return false;
    }

    // Skip if already has license header
    if (hasLicenseHeader(content)) {
        return false;
    }

    const header = LICENSE_HEADERS[ext];

    // Add header with a blank line after it
    const newContent = header + '\n' + content;

    try {
        writeFileSync(filePath, newContent, 'utf-8');
        return true;
    } catch (error) {
        console.error(`Error writing ${filePath}:`, error.message);
        return false;
    }
}

// Returns { files, missingDirs }. A missing directory used to be a
// console.warn that the caller could scroll past — the scan would silently
// continue over whatever directories DID exist, "Found 0 files to process"
// would print same as a real clean scan, and --check would exit 0 having
// verified nothing. Callers now decide what to do with missingDirs; both
// the --check and default paths below treat it as fatal (see the "loudly"
// comment further down).
function findFiles(directories, extensions) {
    const files = [];
    const missingDirs = [];

    for (const dir of directories) {
        const fullPath = join(rootDir, dir);
        if (!existsSync(fullPath)) {
            missingDirs.push(fullPath);
            continue;
        }

        // Use find command to get all files with specified extensions
        const extPattern = extensions.map(ext => `-name "*.${ext}"`).join(' -o ');
        const findCmd = `find "${fullPath}" -type f \\( ${extPattern} \\) ! -path "*/node_modules/*" ! -path "*/dist/*" ! -path "*/target/*"`;

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

    return { files, missingDirs };
}

// --- CLI flags -------------------------------------------------------------
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
        process.exit(1);
    }
}
const checkMode = argv.includes('--check');

// Main execution
//
// `prototype/src` was removed here (not in the `directories` list below): it
// hasn't existed in the repo since the initial-structure commit, but the
// missing-directory check used to be a console.warn the write path quietly
// continued past, so this went unnoticed until the check above started
// treating it as fatal — exactly the kind of drift the missing-directory
// check exists to catch.
const directories = [
    'apps/viewer/src',
    'packages',
    'rust',
    'tests',
];

const extensions = ['ts', 'tsx', 'js', 'css', 'rs'];

console.log('Finding source files...');
const { files, missingDirs } = findFiles(directories, extensions);

// A missing target directory means this script's assumptions about the repo
// layout are stale (wrong cwd, a renamed/moved directory, a restructured
// `packages/`, ...). Silently scanning whatever subset of directories DID
// exist — possibly zero of them — and reporting that as a normal result is
// exactly the false-pass failure mode this script must not have: --check
// exiting 0 having verified nothing, or the default path "adding headers"
// to nothing while believing it covered the repo. Fatal in BOTH modes,
// deliberately, not just --check: a partial write is just as misleading as
// a partial check, it's only less visible because nothing consumes its
// exit code today.
if (missingDirs.length > 0) {
    console.error(`\n❌ Expected director${missingDirs.length === 1 ? 'y' : 'ies'} not found:`);
    for (const dir of missingDirs) {
        console.error(`  ${dir}`);
    }
    console.error(
        `\nThis script resolves its target directories relative to its own location (${rootDir}).\n` +
        'Run it from within the repo, or update the `directories` list above if the repo layout\n' +
        'changed. Refusing to run against a partial/wrong set of directories.'
    );
    process.exit(2);
}

console.log(`Found ${files.length} files to process`);

if (checkMode) {
    // Zero files scanned is not a clean repo — it's a check that verified
    // nothing, and reporting success for it would be the same false-pass
    // bug as the missing-directory case above, just triggered a different
    // way (e.g. the extensions list stops matching anything). Distinct exit
    // code AND distinct wording from "files are missing headers" below:
    // this is "the check could not run", not "the check ran and found a
    // problem to fix".
    if (files.length === 0) {
        console.error(
            '\n❌ --check scanned 0 files. That is a failed check, not a clean repo — ' +
            'refusing to report success for a check that verified nothing.'
        );
        process.exit(2);
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
        const ext = isEligibleFile(file);
        if (!ext) {
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
        process.exit(2);
    }

    if (missing.length > 0) {
        console.log(`\nFiles missing the MPL license header:`);
        for (const file of missing) {
            console.log(`  ${file}`);
        }
        console.log(`\n❌ ${missing.length} file(s) missing the license header. Run without --check to add them.`);
        process.exit(1);
    }

    console.log(`\n✅ All files have the license header.`);
    process.exit(0);
}

let added = 0;
let skipped = 0;
let errors = 0;

for (const file of files) {
    if (addLicenseHeader(file)) {
        added++;
    } else {
        skipped++;
    }
}

console.log(`\nResults:`);
console.log(`  Added headers: ${added}`);
console.log(`  Skipped (already have header or excluded): ${skipped}`);
console.log(`  Errors: ${errors}`);
console.log(`\nDone!`);
