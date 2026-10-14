/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import { runFrameControls } from './frame-gpu-test-runner.mjs';

// Reached by the existing test.yml scripts/perf/*.test.mjs catch-all.
test('#6975 lifecycle and immutable nightly admission production controls', (context) => {
  runFrameControls(context, [
    'scripts/perf/frame-gpu-owned-child.test.ts', 'scripts/perf/frame-gpu-input-idle.test.ts',
    'scripts/perf/frame-gpu-night-admission.test.ts', 'scripts/perf/frame-gpu-night-attempt.test.ts',
    'scripts/perf/frame-gpu-win32-providers.test.ts',
    'scripts/perf/frame-gpu-profile-job.test.ts',
  ], 90_000);
});
