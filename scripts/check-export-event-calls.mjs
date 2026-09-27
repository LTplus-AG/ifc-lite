#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #5844: export completions must use the typed, surface-required entry point. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = execFileSync('git', ['ls-files', 'apps/viewer/src/*.ts', 'apps/viewer/src/*.tsx'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
const raw = /\.\s*capture\s*\(\s*(['"`])export_completed\1/;
const offenders = files.filter((file) => file !== 'apps/viewer/src/lib/analytics.ts' && raw.test(readFileSync(join(root, file), 'utf8')));
if (offenders.length > 0) {
  console.error(`Use trackExportCompleted({ format, surface, … }) instead of raw capture:\n${offenders.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(`Export completion calls are centralized (${files.length} viewer files scanned).`);
}
