/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A node:test reporter that writes, as a JSON array, every test FILE that
 * reported a result (`test:pass` or `test:fail`, which includes skips and a
 * file that crashed on import). Used by scripts/viewer-concurrency-probe.mjs
 * to count what actually ran rather than what was selected.
 *
 * It writes once, when the run ends. A runner killed mid-shard writes
 * nothing, which the probe reads as zero files reported.
 *
 *   --test-reporter=<this file> --test-reporter-destination=<out.json>
 */
export default async function* testFileReporter(source) {
  const files = new Set();
  for await (const event of source) {
    if ((event.type === 'test:pass' || event.type === 'test:fail') && event.data?.file) files.add(event.data.file);
  }
  yield `${JSON.stringify([...files].sort())}\n`;
}
