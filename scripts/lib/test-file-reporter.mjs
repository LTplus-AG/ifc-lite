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
 */
export default async function* testFileReporter(source) {
  const files = new Set();
  for await (const event of source) {
    if (event.type !== 'test:complete') continue;
    const { nesting, name, file } = event.data ?? {};
    if (nesting === 0 && typeof file === 'string' && typeof name === 'string' && (file === name || file.endsWith(`/${name}`))) files.add(file);
  }
  yield `${JSON.stringify([...files].sort())}\n`;
}
