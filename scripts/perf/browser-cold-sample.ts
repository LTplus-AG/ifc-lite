/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ViewerBenchmarkMetrics, ViewerBenchmarkPage } from '../../tests/benchmark/viewer-benchmark-page.ts';

/**
 * The one sequence a cold A/B sample runs on a page (#7032): `setup()` (which
 * switches span tracing on before boot), the caller's own checks, then upload
 * and wait for readiness through `loadUntilReady`. Tracing and readiness are
 * the benchmark page's, never re-implemented by the harness.
 */
export async function runColdSample(
  bp: ViewerBenchmarkPage,
  options: { fixturePath: string; timeoutMs: number; afterSetup?: () => Promise<void> },
): Promise<ViewerBenchmarkMetrics> {
  await bp.setup();
  await options.afterSetup?.();
  await bp.loadUntilReady(options.fixturePath, options.timeoutMs);
  return bp.getMetrics();
}
