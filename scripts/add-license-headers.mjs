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

function addLicenseHeader(filePath) {
    const ext = getFileExtension(filePath);
    if (!ext || !LICENSE_HEADERS[ext]) {
        return false; // Not a file type we handle
    }

    if (shouldExclude(filePath)) {
        return false; // File is excluded
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

function findFiles(directories, extensions) {
    const files = [];

    for (const dir of directories) {
        const fullPath = join(rootDir, dir);
        if (!existsSync(fullPath)) {
            console.warn(`Directory not found: ${fullPath}`);
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

    return files;
}

// Main execution
const directories = [
    'apps/viewer/src',
    'packages',
    'rust',
    'prototype/src',
    'tests',
];

const extensions = ['ts', 'tsx', 'js', 'css', 'rs'];

console.log('Finding source files...');
const files = findFiles(directories, extensions);

console.log(`Found ${files.length} files to process`);

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
