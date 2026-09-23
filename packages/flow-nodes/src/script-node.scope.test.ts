/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Script nodes against the REAL QuickJS sandbox (the sibling
 * `script-node.test.ts` mocks it to test the sandbox cache, so it cannot
 * see this class of bug at all).
 *
 * The bug this pins: one sandbox is shared by every lane, and QuickJS
 * evaluates a program in the global lexical scope, so the second lane of a
 * Script node laced over a list threw "redeclaration of 'inputs'" — and
 * every `const` in the user's own code did the same. The lane error was
 * logged and the lane yielded `null`, so a graph filtering on the result
 * silently kept the wrong elements. A Script node over a list is the
 * ordinary case, not a corner.
 */

import { describe, expect, it } from 'vitest';
import type { Ctx } from './host.js';
import { scriptListNode, scriptNode } from './script-node.js';
import { createFakeBim } from './__tests__/fake-backend.js';

function ctx(bim: ReturnType<typeof createFakeBim>['bim'], logs: string[]): Ctx {
  return { host: { bim }, laneKey: null, log: (level, message) => logs.push(`${level}: ${message}`) };
}

const params = (code: string) => ({ code, timeoutMs: 10_000 });

describe('script nodes in the real sandbox', () => {
  it('re-declares its own bindings on every lane instead of colliding with the last one', async () => {
    const { bim } = createFakeBim();
    const logs: string[] = [];
    const code = 'const factor = 2;\nconst value = inputs.a * factor;\nvalue + 1';
    for (const [a, expected] of [[1, 3], [2, 5], [3, 7]] as const) {
      await expect(scriptNode.run(ctx(bim, logs), { a }, params(code))).resolves.toEqual({ result: expected });
    }
    expect(logs.filter((l) => l.startsWith('error'))).toEqual([]);
  });

  it('gives each lane its own `inputs` and leaks nothing between them', async () => {
    const { bim } = createFakeBim();
    const logs: string[] = [];
    // `carry` would be visible to the next lane if the code shared a scope.
    const code = 'const carry = typeof leaked === "undefined" ? "clean" : "leaked";\nglobalThis.leakCheck = inputs.a;\ncarry + ":" + inputs.a';
    await expect(scriptNode.run(ctx(bim, logs), { a: 'one' }, params(code))).resolves.toEqual({ result: 'clean:one' });
    await expect(scriptNode.run(ctx(bim, logs), { a: 'two' }, params(code))).resolves.toEqual({ result: 'clean:two' });
  });

  it('reads the model, and surfaces a thrown error as a rejection rather than a null result', async () => {
    const { bim } = createFakeBim();
    const logs: string[] = [];
    await expect(scriptNode.run(ctx(bim, logs), {}, params('bim.query.byType("IfcWall").length'))).resolves.toEqual({ result: 3 });
    await expect(scriptNode.run(ctx(bim, logs), {}, params('throw new Error("boom")'))).rejects.toThrow(/boom/);
  });

  it('forwards console output to the run log', async () => {
    const { bim } = createFakeBim();
    const logs: string[] = [];
    await expect(scriptNode.run(ctx(bim, logs), { a: 7 }, params('console.log("seen", inputs.a);\ninputs.a'))).resolves.toEqual({ result: 7 });
    expect(logs).toContain('info: seen 7');
  });

  it('script.list sees whole lists and refuses a result that is not an array', async () => {
    const { bim } = createFakeBim();
    const logs: string[] = [];
    const sort = 'const sorted = inputs.a.slice().sort((x, y) => y - x);\nsorted.slice(0, inputs.c[0])';
    await expect(scriptListNode.run(ctx(bim, logs), { a: [3, 1, 4, 1, 5], c: [2] }, params(sort))).resolves.toEqual({ items: [5, 4] });
    // Without this check the value would reach a list port as a non-list.
    await expect(scriptListNode.run(ctx(bim, logs), { a: [1] }, params('inputs.a.length'))).rejects.toThrow(/must end in an array, got number/);
  });
});
