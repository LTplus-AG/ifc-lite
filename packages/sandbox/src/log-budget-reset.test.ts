/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression tests for the captured-log budget latching per sandbox (#2099).
 *
 * The bridge caps captured console output twice — by entry count
 * (MAX_LOG_ENTRIES = 1000) and by cumulative serialized size
 * (MAX_TOTAL_BYTES = 4MB) — because `vm.dump` copies sandbox values onto the
 * host heap, which the QuickJS memory limit does not bound. `eval()` clears
 * the log buffer at the start of every run, so the caps bound one script's
 * output; the counters behind them used to live for the sandbox's lifetime,
 * so one log-heavy script silenced every later script on the same sandbox.
 *
 * Every script here exhausts the budget by logging, never by allocating, so
 * no test in this file can OOM-abort the shared WASM module.
 */

import { describe, expect, it } from 'vitest';
import type { BimContext } from '@ifc-lite/sdk';
import { createSandbox, type Sandbox } from './sandbox.js';

/** The scripts under test never touch `bim`, so an empty context suffices. */
const EMPTY_SDK = {} as unknown as BimContext;

const TRUNCATION_MARKER = '[log output truncated: limit reached]';

/** Mirrors bridge.ts — the caps are private, so the tests drive their edges. */
const MAX_LOG_ENTRIES = 1000;

/**
 * Logs six 1 MB strings. Each entry serializes to 1048580 bytes
 * (1048576 chars + 2 quotes + 2 brackets). The budget is checked as
 * `totalBytes + entryBytes > MAX_TOTAL_BYTES` before an entry is pushed
 * (#2117), so the running total after 3 entries is 3145740 (<= 4194304, all
 * pushed) and a 4th would be 4194320 (> 4194304, refused): the 4th call is
 * the one that truncates, not the 5th. Returns the marker entry as proof the
 * budget was actually reached — without it every assertion about the *next*
 * eval would be vacuous.
 */
const EXHAUST_BYTE_BUDGET = logPayloads(6);

/**
 * A script that logs `count` 1 MB strings. Wrapped in an IIFE because the
 * sandbox realm outlives the eval: a top-level `const` would make a second run
 * of the same script fail with "redeclaration of 'payload'".
 */
function logPayloads(count: number): string {
  return `(() => { const payload = "x".repeat(1048576); for (let i = 0; i < ${count}; i++) console.log(payload); })();\n1;`;
}

function logArgs(logs: readonly { args: unknown[] }[]): unknown[][] {
  return logs.map((entry) => entry.args);
}

async function withSandbox<T>(run: (sandbox: Sandbox) => Promise<T>): Promise<T> {
  const sandbox = await createSandbox(EMPTY_SDK);
  try {
    return await run(sandbox);
  } finally {
    sandbox.dispose();
  }
}

describe('captured-log budget scope', () => {
  it('does not let a byte-budget-exhausting script silence the next one', async () => {
    await withSandbox(async (sandbox) => {
      const first = await sandbox.eval(EXHAUST_BYTE_BUDGET, { typescript: false });
      // The budget really was reached — otherwise this test proves nothing.
      expect(first.logs).toHaveLength(4);
      expect(first.logs[3]).toMatchObject({ level: 'warn', args: [TRUNCATION_MARKER] });

      const second = await sandbox.eval('console.log("second"); 2;', { typescript: false });

      expect(second.value).toBe(2);
      expect(logArgs(second.logs)).toEqual([['second']]);
    });
  }, 60_000);

  it('does not let an entry-cap-exhausting script silence the next one', async () => {
    await withSandbox(async (sandbox) => {
      const first = await sandbox.eval(
        `for (let i = 0; i < ${MAX_LOG_ENTRIES + 5}; i++) console.log(i);\n1;`,
        { typescript: false },
      );
      expect(first.logs).toHaveLength(MAX_LOG_ENTRIES + 1);
      expect(first.logs[MAX_LOG_ENTRIES]).toMatchObject({ level: 'warn', args: [TRUNCATION_MARKER] });

      const second = await sandbox.eval('console.log("second"); 2;', { typescript: false });

      expect(logArgs(second.logs)).toEqual([['second']]);
    });
  }, 60_000);

  it('keeps truncating a single script that genuinely exceeds the byte cap', async () => {
    await withSandbox(async (sandbox) => {
      const result = await sandbox.eval(EXHAUST_BYTE_BUDGET, { typescript: false });

      expect(result.value).toBe(1);
      expect(result.logs).toHaveLength(4);
      expect(result.logs.slice(0, 3).map((entry) => (entry.args[0] as string).length)).toEqual([
        1048576, 1048576, 1048576,
      ]);
      expect(result.logs[3]).toMatchObject({ level: 'warn', args: [TRUNCATION_MARKER] });
    });
  }, 60_000);

  it('charges each eval its own budget rather than accumulating across evals', async () => {
    await withSandbox(async (sandbox) => {
      // Three 1 MB entries per eval: under the 4 MB cap on its own, over it if
      // the charge carried across evals. Repeated three times, so a carried
      // charge would show up by the second or third run at the latest.
      const script = logPayloads(3);
      for (let run = 0; run < 3; run++) {
        const result = await sandbox.eval(script, { typescript: false });
        expect(result.logs).toHaveLength(3);
        expect(logArgs(result.logs).flat().some((arg) => arg === TRUNCATION_MARKER)).toBe(false);
      }
    });
  }, 60_000);

  it('does not let an exhausting script silence an eval that throws', async () => {
    await withSandbox(async (sandbox) => {
      const first = await sandbox.eval(EXHAUST_BYTE_BUDGET, { typescript: false });
      expect(first.logs[3]).toMatchObject({ args: [TRUNCATION_MARKER] });

      await expect(
        sandbox.eval('console.log("before throw"); throw new Error("boom");', { typescript: false }),
      ).rejects.toMatchObject({ logs: [expect.objectContaining({ args: ['before throw'] })] });
    });
  }, 60_000);
});
