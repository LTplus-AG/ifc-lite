/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Refuse summaries that contradict or outlive the runner process. */
export function processResultGap(parsed, run) {
  if (run.signal || run.exitCode === null) {
    return {
      kind: 'unparseable', passed: parsed.passed ?? null, failed: parsed.failed ?? null,
      total: parsed.total ?? null,
      evidence: [run.signal ? `runner terminated by ${run.signal}` : 'runner returned no exit status'],
    };
  }
  if (run.exitCode !== 0 && (parsed.kind === 'pass' || (parsed.failed === 0 && (parsed.total ?? 0) > 0))) {
    return {
      kind: 'unparseable', passed: parsed.passed ?? null, failed: parsed.failed ?? null,
      total: parsed.total ?? null, evidence: [`runner printed a green summary but exited ${run.exitCode}`],
    };
  }
  if (run.exitCode === 0 && ((parsed.failed ?? 0) > 0 || parsed.kind === 'assertion-failure')) {
    return {
      kind: 'unparseable', passed: parsed.passed ?? null, failed: parsed.failed ?? null,
      total: parsed.total ?? null, evidence: ['runner printed failures but exited 0'],
    };
  }
  return null;
}
