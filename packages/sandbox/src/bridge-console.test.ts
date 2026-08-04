/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The bridge sizes every captured log entry with `JSON.stringify` to charge it
 * against the host memory budget. Some sandbox values survive `vm.dump` but not
 * `JSON.stringify` (a BigInt is the reachable case), so that sizing can throw.
 *
 * Two properties are pinned here, and they pull against each other:
 *   - the failure is *reported* (house rule: no silent catch), and
 *   - it is reported at most once per context — the trigger is script-supplied,
 *     so a per-entry log would let `for(;;) console.log(1n)` flood the host.
 */

import { describe, expect, it, vi } from 'vitest';
import type { BimContext } from '@ifc-lite/sdk';
import { createSandbox } from './sandbox.js';

const SIZING_WARNING = 'could not be sized';

describe('captured-log sizing failures', () => {
  it('warns once, not per entry, when an entry cannot be sized', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sandbox = await createSandbox({} as unknown as BimContext);
    try {
      const result = await sandbox.eval('console.log(1n); console.log(2n); console.log(3n); 42;');
      // Logging still succeeds — sizing failure must not drop the entry.
      expect(result.value).toBe(42);
      expect(result.logs).toHaveLength(3);

      const sizingWarnings = warn.mock.calls.filter((call) => String(call[0]).includes(SIZING_WARNING));
      expect(sizingWarnings).toHaveLength(1);
    } finally {
      warn.mockRestore();
      sandbox.dispose();
    }
  });
});
