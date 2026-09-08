/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The bridge caps captured console output twice: by entry count
 * (MAX_LOG_ENTRIES = 1000) and by cumulative serialized size
 * (MAX_TOTAL_BYTES = 4MB). Both caps exist because `vm.dump` copies sandbox
 * values onto the host heap, which the QuickJS memory limit does not bound.
 *
 * The byte cap can only charge for what it can measure. A top-level BigInt is
 * the one sandbox value that survives `vm.dump` intact but has no JSON form
 * (an object the VM cannot serialize arrives already flattened to the string
 * "[object Object]"), so `JSON.stringify` throws — and a BigInt is unbounded
 * in size. Retaining such an argument would consume an entry slot while
 * contributing nothing to the byte budget (#2087), so the bridge replaces it
 * with bounded text and charges exactly that.
 *
 * Two further properties are pinned here, and they pull against each other:
 *   - the sizing failure is *reported* (house rule: no silent catch), and
 *   - it is reported at most once per context — the trigger is script-supplied,
 *     so a per-entry log would let `for(;;) console.log(1n)` flood the host.
 */

import { describe, expect, it, vi } from 'vitest';
import type { BimContext } from '@ifc-lite/sdk';
import { createSandbox } from './sandbox.js';

const SIZING_WARNING = 'could not be sized';
const TRUNCATION_MARKER = '[log output truncated: limit reached]';

/** Mirrors bridge.ts — the caps are private, so the tests drive their edges. */
const MAX_LOG_ENTRIES = 1000;

async function withSandbox<T>(run: (sandbox: Awaited<ReturnType<typeof createSandbox>>) => Promise<T>): Promise<T> {
  const sandbox = await createSandbox({} as unknown as BimContext);
  try {
    return await run(sandbox);
  } finally {
    sandbox.dispose();
  }
}

describe('captured-log byte budget', () => {
  it('does not retain a log argument it could not size', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await withSandbox(async (sandbox) => {
        // `1n << 100000n` is ~12.5 KB of host BigInt — small enough to keep
        // the test quick and to pose no risk to the shared WASM module, but
        // repeated to the entry cap it is ~12 MB of host memory the byte
        // budget used to charge nothing for. (QuickJS itself refuses to
        // allocate a BigInt much past a million bits.)
        const result = await sandbox.eval(
          'const huge = 1n << 100000n;\nfor (let i = 0; i < 6; i++) console.log(huge);\n42;',
        );
        expect(result.value).toBe(42);
        expect(result.logs).toHaveLength(6);

        // Nothing unsizeable survives on the host heap, so what the budget
        // charged and what the host actually holds are the same thing.
        const retained = result.logs.flatMap((entry) => entry.args);
        expect(retained.some((arg) => typeof arg === 'bigint')).toBe(false);
        expect(() => JSON.stringify(retained)).not.toThrow();
        expect(JSON.stringify(retained).length).toBeLessThan(1024);
        expect(result.logs[0]?.args).toEqual(['[BigInt too large to retain]']);

        // The catch really fired — without this the rest of the test is vacuous.
        const sizingWarnings = warn.mock.calls.filter((call) => String(call[0]).includes(SIZING_WARNING));
        expect(sizingWarnings).toHaveLength(1);
      });
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps a small BigInt readable and leaves its neighbours untouched', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await withSandbox(async (sandbox) => {
        const result = await sandbox.eval('console.log("count", 42n, { ok: true }); 1;');
        expect(result.logs).toHaveLength(1);
        expect(warn.mock.calls.filter((call) => String(call[0]).includes(SIZING_WARNING))).toHaveLength(1);
        // The failure costs the offending argument only, not the log line.
        expect(result.logs[0]?.args).toEqual(['count', '42n', { ok: true }]);
      });
    } finally {
      warn.mockRestore();
    }
  });

  it('warns once, not per entry, when entries cannot be sized', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await withSandbox(async (sandbox) => {
        const result = await sandbox.eval('console.log(1n); console.log(2n); console.log(3n); 42;');
        // Logging still succeeds — a sizing failure must not drop the entry.
        expect(result.value).toBe(42);
        expect(result.logs).toHaveLength(3);
        expect(result.logs.map((entry) => entry.args)).toEqual([['1n'], ['2n'], ['3n']]);

        const sizingWarnings = warn.mock.calls.filter((call) => String(call[0]).includes(SIZING_WARNING));
        expect(sizingWarnings).toHaveLength(1);
      });
    } finally {
      warn.mockRestore();
    }
  });

  it('refuses a single entry that would overshoot the byte ceiling, rather than retaining it in full', async () => {
    // #2117: the budget used to be checked BEFORE the entry about to be added,
    // never against it — so `totalBytes` started at 0 (< MAX_TOTAL_BYTES) and a
    // single oversized argument sailed through and was retained whole, with the
    // overshoot bounded only by whatever the script chose to log. One 5 MB
    // string (well over the 4 MiB budget) must now be refused outright and
    // replaced by the truncation marker, not retained.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await withSandbox(async (sandbox) => {
        const result = await sandbox.eval(
          'console.log("x".repeat(5 * 1024 * 1024)); 1;',
        );
        expect(result.value).toBe(1);

        // The oversized entry must not be present at all.
        expect(result.logs).toHaveLength(1);
        expect(result.logs[0]).toMatchObject({ level: 'warn', args: [TRUNCATION_MARKER] });

        // Whatever *is* retained must stay within the 4 MiB budget — this is
        // the actual property under test: cumulative retained bytes must never
        // exceed MAX_TOTAL_BYTES, no matter how large a single call's argument.
        const retainedBytes = JSON.stringify(result.logs.flatMap((entry) => entry.args)).length;
        expect(retainedBytes).toBeLessThan(4 * 1024 * 1024);
      });
    } finally {
      warn.mockRestore();
    }
  });

  it('charges serializable entries exactly as before and truncates on the same entry', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await withSandbox(async (sandbox) => {
        // Each entry serializes to ["x"*1048576] = 1048576 + 2 quotes +
        // 2 brackets = 1048580 bytes.
        //
        // #2117 deliberately moved this boundary. The OLD check-before-add
        // code (`totalBytes >= MAX_TOTAL_BYTES`, evaluated before the entry
        // about to be added was even sized) let a fourth full entry land:
        // 4 x 1048580 = 4194320, which is 16 bytes OVER the 4194304 budget —
        // the bug this issue fixed, illustrated exactly by that overshoot —
        // and only the fifth call truncated.
        //
        // The NEW check (`totalBytes + entryBytes > MAX_TOTAL_BYTES`,
        // evaluated before the entry is pushed) walks the running total entry
        // by entry:
        //   entry 1: totalBytes   0 + 1048580 = 1048580 <= 4194304 -> pushed
        //   entry 2: totalBytes 1048580 + 1048580 = 2097160 <= 4194304 -> pushed
        //   entry 3: totalBytes 2097160 + 1048580 = 3145740 <= 4194304 -> pushed
        //   entry 4: totalBytes 3145740 + 1048580 = 4194320 >  4194304 -> REFUSED,
        //            truncation marker pushed instead, `truncated` latches true
        //   entries 5, 6: `truncated` is already true, eval returns immediately
        //
        // So only 3 full entries land (3145740 bytes retained, not 4194320 —
        // a 4th would put the total 16 bytes over budget), followed by one
        // truncation marker: `result.logs` has length 4, not 5.
        const result = await sandbox.eval(
          'const payload = "x".repeat(1048576);\nfor (let i = 0; i < 6; i++) console.log(payload);\n7;',
        );
        expect(result.value).toBe(7);
        expect(result.logs).toHaveLength(4);
        expect(result.logs.slice(0, 3).map((entry) => (entry.args[0] as string).length)).toEqual([
          1048576, 1048576, 1048576,
        ]);
        expect(result.logs[3]).toMatchObject({ level: 'warn', args: [TRUNCATION_MARKER] });
        // Nothing here is unsizeable: the sizing path must stay silent.
        expect(warn.mock.calls.filter((call) => String(call[0]).includes(SIZING_WARNING))).toHaveLength(0);
      });
    } finally {
      warn.mockRestore();
    }
  });

  it('charges the fallback path something proportionate, not a wild overestimate', async () => {
    // The magnitude of the FALLBACK charge was unpinned (maintainer negative
    // control on #2096): replacing `bytes += json?.length ?? 0` inside
    // retainSizeableArgs with a 10-million-fold constant left every other test
    // in this file green. Nothing noticed, because the exact-charge test above
    // drives the happy path — `retainSizeableArgs` only runs once
    // `JSON.stringify` of the whole argument array has already thrown.
    //
    // Over-charging is the mirror image of the bug #2087 fixed: instead of
    // retaining entries the budget cannot see, it would discard entries the
    // budget should have had room for. Approximate is fine here (the comment
    // in bridge.ts says "approximate host cost", and String.length undercounts
    // UTF-8 bytes for non-ASCII anyway) — orders of magnitude wrong is not.
    //
    // Observable proxy for `totalBytes`, which is private: one entry carrying
    // an unsizeable argument must not exhaust a 4MB budget by itself. Under
    // the 10-million mutation the very next entry truncates.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await withSandbox(async (sandbox) => {
        const result = await sandbox.eval(
          'console.log(1n, "small");\nfor (let i = 0; i < 3; i++) console.log("after", i);\n9;',
        );
        expect(result.value).toBe(9);
        // 4 entries, and none of them the truncation marker: the first entry's
        // fallback charge left room for the rest.
        expect(result.logs).toHaveLength(4);
        expect(result.logs.map((entry) => entry.args[0])).not.toContain(TRUNCATION_MARKER);
        // The sizing failure still happened — otherwise this test would pass
        // by never reaching the fallback path at all.
        expect(warn.mock.calls.filter((call) => String(call[0]).includes(SIZING_WARNING))).toHaveLength(1);
      });
    } finally {
      warn.mockRestore();
    }
  });

  it('still caps the entry count', async () => {
    await withSandbox(async (sandbox) => {
      const result = await sandbox.eval(
        `for (let i = 0; i < ${MAX_LOG_ENTRIES + 5}; i++) console.log(i);\n1;`,
      );
      expect(result.logs).toHaveLength(MAX_LOG_ENTRIES + 1);
      expect(result.logs[MAX_LOG_ENTRIES]).toMatchObject({ level: 'warn', args: [TRUNCATION_MARKER] });
    });
  });
});
