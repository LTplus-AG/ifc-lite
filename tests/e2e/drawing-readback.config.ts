/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { defineConfig } from '@playwright/test';
import backing from './geometry-backing.config';

// The viewer drawing over released geometry (#10264): the backing proof's
// browser setup (GEOMETRY_BACKING_GPU=1 for a real adapter), its own spec and output.
export default defineConfig({
  ...backing,
  testMatch: /drawing-readback-release\.e2e\.spec\.ts/,
  outputDir: '../../test-results/drawing-readback',
  reporter: [['list'], ['json', { outputFile: '../../test-results/drawing-readback-results.json' }]],
});
