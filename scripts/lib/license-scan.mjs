/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Enumerating the files the license gate is responsible for.
 *
 * Split from `scripts/add-license-headers.mjs` because deciding WHICH files a
 * run covers is a different job from deciding what to do with them, and the
 * two fail differently: this module's failures are all "the run covered less
 * than it claims", which the CLI must turn into a refusal rather than a
 * result. Keeping it separate is also what lets the coverage rules be tested
 * without importing a CLI that scans and writes.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { EXCLUDED_DIRS } from './license-header.mjs';

// The scan-root entry that means "the repository root itself". `findFiles`
// scans it non-recursively; see the comment on the `find` command below.
export const REPO_ROOT = '.';

// Returns { files, missingRoots, scanErrors }. A missing scan root used to be a
// console.warn that the caller could scroll past — the scan would silently
// continue over whatever roots DID exist, "Found 0 files to process"
// would print same as a real clean scan, and --check would exit 0 having
// verified nothing. Callers now decide what to do with missingRoots; both
// the --check and default paths below treat it as fatal (see the "loudly"
// comment further down).
export function findFiles(rootDir, scanRoots, extensions) {
    const files = [];
    const missingRoots = [];
    const scanErrors = [];

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
            // An explicit maxBuffer, because Node's default is 1 MiB and a root
            // that outgrows it raises ENOBUFS. That lands in the catch below,
            // which used to log and continue, so the root contributed ZERO files
            // and the scan reported success having never looked at it. Under-
            // scanning that announces itself as a clean result is the exact
            // failure this gate exists to prevent, so the size is raised AND the
            // failure is recorded.
            const output = execSync(findCmd, {
                encoding: 'utf-8',
                cwd: rootDir,
                maxBuffer: 64 * 1024 * 1024,
            });
            const foundFiles = output.trim().split('\n').filter(f => f);
            files.push(...foundFiles);
        } catch (error) {
            // Exit 1 from `find` means "matched nothing", which is a real answer
            // for a root that legitimately holds no scanned extension. Anything
            // else means the enumeration did not happen, and a root nobody
            // enumerated is not a root anybody checked: record it so the caller
            // can refuse rather than quietly scanning the remainder.
            if (error.status !== 1) {
                scanErrors.push({ root: dir, message: error.message });
            }
        }
    }

    return { files, missingRoots, scanErrors };
}
