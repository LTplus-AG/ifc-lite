/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A node:test reporter that writes, as a JSON array, every test FILE whose
 * run completed. Used by scripts/viewer-concurrency-probe.mjs to count what
 * actually ran rather than what was selected.
 *
 * It reads the FILE-level event, not the tests'. A test's `data.file` is where
 * `test()` was CALLED, so a test declared in a shared helper (apps/viewer's
 * i18n catalogue tests call one from `__tests__/catalogue-contract.ts`) is
 * credited to the helper. With process isolation the runner also completes
 * one top-level test per file, named by the path it was given, whose
 * `data.file` is that file: that is what this counts. It fires for a passing
 * file, a skip-only file and a file that crashed on import.
 *
 * It writes once, when the run ends. A runner killed mid-shard writes
 * nothing, which the probe reads as zero files reported.
 *
 *   --test-reporter=<this file> --test-reporter-destination=<out.json>
 * With TEST_FILE_REPORT_FORMAT=durations, report viewer-relative paths and
 * each file's duration in seconds using the same file-level events.
 */
import { relative } from 'node:path';

export default async function* testFileReporter(source) {
  const files = new Map();
  const durations = process.env.TEST_FILE_REPORT_FORMAT === 'durations';
  for await (const event of source) {
    if (event.type !== 'test:complete') continue;
    const { nesting, name, file, details } = event.data ?? {};
    if (nesting === 0 && typeof file === 'string' && typeof name === 'string' && (file === name || file.endsWith(`/${name}`))) files.set(file, details?.duration_ms);
  }
  const paths = [...files.keys()].sort();
  const result = durations ? Object.fromEntries(paths.map((file) => [
    relative(process.cwd(), file).split('\\').join('/'), files.get(file) / 1000,
  ])) : paths;
  yield `${JSON.stringify(result)}\n`;
}
