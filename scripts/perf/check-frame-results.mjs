#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs';
import { tsImport } from 'tsx/esm/api';

try {
  if (process.argv.length !== 3) throw new Error('usage: check-frame-results.mjs <browser-frames.json>');
  const { requireFrameEvidence } = await tsImport('../../tests/benchmark/frames/frame-evidence.ts', import.meta.url);
  requireFrameEvidence(JSON.parse(readFileSync(process.argv[2], 'utf8')));
  console.log('browser-frames: complete uncontaminated evidence; metrics remain informational');
} catch (error) {
  console.error(`[browser-frames] ${String(error)}`);
  process.exitCode = 1;
}
