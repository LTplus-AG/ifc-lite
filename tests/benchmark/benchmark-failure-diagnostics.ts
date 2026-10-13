/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ViewerBenchmarkPage } from './viewer-benchmark-page';

type DiagnosticPage = Pick<ViewerBenchmarkPage, 'refreshLoadTrace' | 'getLoadTrace' | 'getConsoleLogs'>;
const describeError = (error: unknown) => error instanceof Error
  ? { name: error.name, message: error.message, stack: error.stack }
  : { name: 'NonError', message: String(error) };

/** #7005: retain evidence when readiness fails, without turning it into a
 * sample or replacing its original error with a diagnostic collection error. */
export async function withBenchmarkFailureDiagnostics<T>(
  page: DiagnosticPage,
  fileName: string,
  run: () => Promise<T>,
  options: { outputDir?: string; captureTimeoutMs?: number } = {},
): Promise<T> {
  try {
    return await run();
  } catch (originalError) {
    const collectionErrors: ReturnType<typeof describeError>[] = [];
    let trace: ReturnType<DiagnosticPage['getLoadTrace']> = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        page.refreshLoadTrace(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Failure trace capture timed out')), options.captureTimeoutMs ?? 5_000);
        }),
      ]);
      trace = page.getLoadTrace();
    } catch (error) {
      collectionErrors.push(describeError(error));
    } finally {
      clearTimeout(timer);
    }
    let consoleLogs: string[] = [];
    try {
      consoleLogs = page.getConsoleLogs();
    } catch (error) {
      collectionErrors.push(describeError(error));
    }
    const outputDir = options.outputDir ?? join(process.cwd(), 'tests/benchmark',
      process.env.VIEWER_BENCHMARK_GPU_UPLOADS === '1' ? 'benchmark-count-results' : 'benchmark-results');
    const stem = fileName.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 64);
    const prefix = join(outputDir, `failure-${stem}-${randomUUID()}`);
    try {
      mkdirSync(outputDir, { recursive: true });
      writeFileSync(`${prefix}.console.log`, consoleLogs.join('\n'));
    } catch (error) {
      collectionErrors.push(describeError(error));
    }
    try {
      writeFileSync(`${prefix}.json`, JSON.stringify({
        status: 'failed', file: fileName, capturedAt: new Date().toISOString(),
        error: describeError(originalError), trace, collectionErrors,
      }, null, 2));
    } catch (error) {
      collectionErrors.push(describeError(error));
    }
    for (const error of collectionErrors) console.error('[Benchmark] failure diagnostic collection error:', error);
    throw originalError;
  }
}
