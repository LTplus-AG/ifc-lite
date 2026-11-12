/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Viewer tests skipped because the contrast harness found no browser
 * (`apps/viewer/src/test/contrast/browser-resolution.ts`, whose skip reason
 * starts with {@link CONTRAST_SKIP_MARKER}).
 *
 * Two consumers, so a skip never reads as a pass:
 *  - `scripts/check-contrast-skips.mjs` fails a CI viewer shard whose JUnit
 *    report holds any such skip. The harness never skips in CI today; the gate
 *    keeps a later loosening from turning a shard green quietly.
 *  - The default export is a `node --test` reporter (wired in the viewer's
 *    `test` script) that ends a local run with one line counting them.
 */

import { spec, tap } from 'node:test/reporters';
import { Readable, pipeline } from 'node:stream';

/** Every skip reason the contrast harness gives starts with this. */
export const CONTRAST_SKIP_MARKER = 'contrast harness:';

/** @param {string | boolean | undefined} reason a test's `skip` value */
export function isContrastSkip(reason) {
  return typeof reason === 'string' && reason.startsWith(CONTRAST_SKIP_MARKER);
}

/** Count `<skipped message="contrast harness: ...">` entries in a node JUnit report. */
export function countJunitContrastSkips(xml) {
  let count = 0;
  for (const [, message] of xml.matchAll(/<skipped\b[^>]*\bmessage="([^"]*)"/g)) {
    if (isContrastSkip(message)) count++;
  }
  return count;
}

/** The line a run ends with when it skipped contrast tests. */
export function contrastSkipSummary(count) {
  return `!! ${count} contrast test(s) SKIPPED, not passed: no browser for the contrast harness. `
    + 'Install Google Chrome, run `pnpm exec playwright install chromium`, or set IFCLITE_TEST_CHROME_EXECUTABLE.';
}

/** True when NODE_OPTIONS already sends a reporter to stdout (CI does). A
 *  reporter without a destination of its own goes to stdout. */
export function nodeOptionsReportToStdout(nodeOptions = '') {
  const reporters = nodeOptions.match(/--test-reporter(?:=|\s+)(?!-)/g)?.length ?? 0;
  const destinations = [...nodeOptions.matchAll(/--test-reporter-destination(?:=|\s+)(\S+)/g)].map((m) => m[1]);
  return destinations.includes('stdout') || reporters > destinations.length;
}

/** node's own default reporter: spec on a terminal, and since Node 24 everywhere. */
function defaultReporter(events) {
  if (!process.stdout.isTTY && Number(process.versions.node.split('.')[0]) < 24) return tap(events);
  const rendered = new spec();
  pipeline(Readable.from(events), rendered, () => {}); // an error destroys `rendered`, failing the loop below
  return rendered;
}

/**
 * `node --test` reporter. When NODE_OPTIONS already sends a reporter to
 * stdout (CI does), it adds only the summary line, so that output is not
 * duplicated. Otherwise it also renders node's default, which naming any
 * reporter on the command line would switch off.
 */
export default async function* contrastSkipReporter(source) {
  let skipped = 0;
  async function* counted() {
    for await (const event of source) {
      if (event.type === 'test:pass' && isContrastSkip(event.data.skip)) skipped++;
      yield event;
    }
  }
  if (nodeOptionsReportToStdout(process.env.NODE_OPTIONS)) {
    for await (const event of counted()) void event;
  } else {
    for await (const chunk of defaultReporter(counted())) yield chunk;
  }
  if (skipped > 0) yield `\n${contrastSkipSummary(skipped)}\n`;
}
