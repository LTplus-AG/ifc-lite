/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #2422 — the declared `bim.clash` surface must match what the runtime delivers.
 *
 * Every `bim.clash` method used to be declared `Promise<unknown>` / `unknown[]`
 * while the runtime returned a fully structured `ClashResult`. That is a
 * declaration that lies by omission: a script author could not read
 * `result.clashes` or `result.summary.total` off the declared type without a
 * cast, even though both demonstrably exist.
 *
 * The generated declarations are now EXTRACTED from `packages/clash/src` by
 * `scripts/generate-bim-globals.mjs`, so they cannot drift from the engine's
 * types — `pnpm check:bim-globals` goes red when the engine changes. What that
 * gate cannot see is the other half of the claim: that the value which actually
 * arrives in the realm, after `marshalValue` has rebuilt the whole object graph
 * handle by handle, still HAS those fields.
 *
 * So these assertions are made from INSIDE the sandbox, on the real engine and
 * the real bridge, and read exactly what a script author reads. They are
 * supersets (`arrayContaining`): a field added upstream is the generator's
 * business, a field the runtime stops providing is this suite's.
 */

import { describe, expect, it } from 'vitest';
import { ClashNamespace, type BimContext } from '@ifc-lite/sdk';
import { createSandbox } from './sandbox.js';
import { SANDBOX_CONSOLE_LEVELS } from './types.js';

/** A unit cube at `x`, meshed as 12 triangles — enough for the engine to run for real. */
function cube(key: string, x: number, tag: string): Record<string, unknown> {
  return {
    key,
    ref: key === 'a' ? 1 : 2,
    model: 'm',
    tag,
    bounds: { min: [x, 0, 0], max: [x + 1, 1, 1] },
    positions: [
      x, 0, 0, x + 1, 0, 0, x + 1, 1, 0, x, 1, 0,
      x, 0, 1, x + 1, 0, 1, x + 1, 1, 1, x, 1, 1,
    ],
    indices: [
      0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
      2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 0, 3, 7, 0, 7, 4,
    ],
  };
}

const RULES = [{ id: 'r1', name: 'wall x slab', a: 'IfcWall', b: 'IfcSlab', mode: 'hard' }];

function sdkWithClash(): BimContext {
  return { clash: new ClashNamespace() } as unknown as BimContext;
}

/** Run `script` in a real sandbox and return the value it resolved to. */
async function evalInSandbox(script: string): Promise<Record<string, unknown>> {
  const sandbox = await createSandbox(sdkWithClash(), { limits: { timeoutMs: 30_000 } });
  try {
    const result = await sandbox.eval(script);
    // The script is an async IIFE, so a rejection arrives as a settled value
    // rather than a throw. Surfacing it here means a broken script is reported
    // as itself, not as `undefined has no property` inside an assertion.
    expect(result.value).toMatchObject({ type: 'fulfilled' });
    return (result.value as { value: Record<string, unknown> }).value;
  } finally {
    sandbox.dispose();
  }
}

describe('#2422 — bim.clash returns what its declaration promises', () => {
  it('delivers a structured ClashResult into the realm, not an opaque value', async () => {
    const observed = await evalInSandbox(`
      const elements = ${JSON.stringify([cube('a', 0, 'IfcWall'), cube('b', 0.5, 'IfcSlab')])};
      (async () => {
        const result = await bim.clash.run(elements, ${JSON.stringify(RULES)}, {});
        const clash = result.clashes[0];
        return {
          resultKeys: Object.keys(result).sort(),
          summaryKeys: Object.keys(result.summary).sort(),
          settingsKeys: Object.keys(result.settings).sort(),
          clashKeys: Object.keys(clash).sort(),
          elementRefKeys: Object.keys(clash.a).sort(),
          boundsKeys: Object.keys(clash.bounds).sort(),
          pointLength: clash.point.length,
          minLength: clash.bounds.min.length,
          rulesRunKeys: Object.keys(result.rulesRun[0]).sort(),
          total: result.summary.total,
          clashCount: result.clashes.length,
          toleranceType: typeof result.settings.tolerance,
          excludeType: typeof result.settings.excludeVoidsAndHosts,
          severity: clash.severity,
          status: clash.status,
        };
      })();
    `);

    // The five members of `ClashResult`. `truncated` is absent by contract when
    // nothing was dropped, so it is not required here.
    expect(observed.resultKeys).toEqual(
      expect.arrayContaining(['clashes', 'rulesRun', 'settings', 'summary']),
    );
    expect(observed.summaryKeys).toEqual(
      expect.arrayContaining(['byRule', 'bySeverity', 'byTypePair', 'total']),
    );
    expect(observed.settingsKeys).toEqual(
      expect.arrayContaining(['excludeVoidsAndHosts', 'tolerance']),
    );
    expect(observed.toleranceType).toBe('number');
    expect(observed.excludeType).toBe('boolean');

    // `Clash`, including the two nested shapes the declaration names: an
    // `AABB` (`{ min, max }`) and a `Vec3` (a 3-tuple). Both are plain object
    // graphs, which is why they survive `marshalValue` — asserted, not assumed.
    expect(observed.clashKeys).toEqual(
      expect.arrayContaining(['a', 'b', 'bounds', 'distance', 'id', 'point', 'rule', 'severity', 'status']),
    );
    expect(observed.elementRefKeys).toEqual(
      expect.arrayContaining(['key', 'model', 'ref', 'tag']),
    );
    expect(observed.boundsKeys).toEqual(expect.arrayContaining(['max', 'min']));
    expect(observed.pointLength).toBe(3);
    expect(observed.minLength).toBe(3);
    expect(observed.rulesRunKeys).toEqual(expect.arrayContaining(['a', 'id', 'mode', 'name']));

    // The two overlapping cubes really did clash — otherwise every key
    // assertion above would be reading fields off an empty report.
    expect(observed.clashCount).toBe(1);
    expect(observed.total).toBe(1);
    expect(observed.severity).toBeTypeOf('string');
    expect(observed.status).toBe('hard');
  }, 60_000);

  it('delivers ClashGroup[] from group(), keyed for a BCF topic', async () => {
    const observed = await evalInSandbox(`
      const elements = ${JSON.stringify([cube('a', 0, 'IfcWall'), cube('b', 0.5, 'IfcSlab')])};
      (async () => {
        const result = await bim.clash.run(elements, ${JSON.stringify(RULES)}, {});
        const groups = bim.clash.group(result, 'rule');
        return {
          groupCount: groups.length,
          groupKeys: Object.keys(groups[0]).sort(),
          memberKeys: Object.keys(groups[0].members[0]).sort(),
          representativePointLength: groups[0].representativePoint.length,
        };
      })();
    `);

    expect(observed.groupCount).toBe(1);
    expect(observed.groupKeys).toEqual(
      expect.arrayContaining(['bounds', 'id', 'members', 'representativePoint', 'severity', 'title']),
    );
    expect(observed.memberKeys).toEqual(expect.arrayContaining(['a', 'b', 'id', 'rule', 'status']));
    expect(observed.representativePointLength).toBe(3);
  }, 60_000);

  it('accepts a bare { clashes } into group(), which is all the runtime requires', async () => {
    // #2422 review (Codex, bridge-clash.ts:198). Declaring the `result`
    // parameter as the full `ClashResult` would have rejected this call at type
    // level while the runtime accepts it: the bridge guard requires only a
    // `clashes` array, and `groupClashes` dereferences exactly one field of its
    // argument (`const clashes = result.clashes`, grouping.ts:323).
    //
    // That is the mirror image of the bug this suite exists for. The `unknown`
    // returns UNDERSTATED the runtime; a required `ClashResult` here would
    // OVERSTATE it. The declaration is `Pick<ClashResult, 'clashes'> &
    // Partial<ClashResult>`, and this is the runtime half of that claim —
    // the type half is a tsc probe over the generated .d.ts.
    const observed = await evalInSandbox(`
      (async () => {
        const empty = bim.clash.group({ clashes: [] }, 'rule');
        let rejected = 'not rejected';
        try {
          bim.clash.group({ nope: true }, 'rule');
        } catch (err) {
          rejected = err.message;
        }
        return { emptyIsArray: Array.isArray(empty), emptyLength: empty.length, rejected };
      })();
    `);

    expect(observed.emptyIsArray).toBe(true);
    expect(observed.emptyLength).toBe(0);
    // The guard that makes the narrowing safe is still the guard: an object
    // WITHOUT a clashes array is refused, so the declared type is not merely
    // permissive.
    expect(observed.rejected).toContain('must be a ClashResult');
  }, 30_000);

  it('distinguishes presets() (ClashRulePreset) from disciplineRules() (ClashRule)', async () => {
    // The plausible-but-wrong reading of the issue is that BOTH return
    // `ClashRule[]`. They do not: a preset is the discipline PAIR
    // (`selectorA`/`selectorB` plus a description) and `disciplineRules()` is
    // what turns presets into runnable rules (`a`/`b`/`mode`). Asserting each
    // shape has the other's discriminating field ABSENT is what makes this
    // test able to fail if the two are ever conflated again.
    const observed = await evalInSandbox(`
      (async () => {
        const preset = bim.clash.presets()[0];
        const rule = bim.clash.disciplineRules('hard')[0];
        return {
          presetKeys: Object.keys(preset).sort(),
          ruleKeys: Object.keys(rule).sort(),
          presetHasSelectorA: 'selectorA' in preset,
          presetHasA: 'a' in preset,
          ruleHasA: 'a' in rule,
          ruleHasSelectorA: 'selectorA' in rule,
          ruleMode: rule.mode,
          presetCount: bim.clash.presets().length,
          ruleCount: bim.clash.disciplineRules('hard').length,
        };
      })();
    `);

    expect(observed.presetKeys).toEqual(
      expect.arrayContaining(['description', 'id', 'name', 'selectorA', 'selectorB', 'severity']),
    );
    expect(observed.presetHasSelectorA).toBe(true);
    expect(observed.presetHasA).toBe(false);

    expect(observed.ruleKeys).toEqual(expect.arrayContaining(['a', 'b', 'id', 'mode', 'name']));
    expect(observed.ruleHasA).toBe(true);
    expect(observed.ruleHasSelectorA).toBe(false);
    expect(observed.ruleMode).toBe('hard');

    expect(observed.presetCount).toBeGreaterThan(0);
    expect(observed.ruleCount).toBeGreaterThan(0);
  }, 60_000);
});

describe('#2422 — the declared sandbox console matches the installed one', () => {
  it('installs exactly SANDBOX_CONSOLE_LEVELS, and nothing wider', async () => {
    // `bim-globals.d.ts` declares `console` from this same list, which is what
    // lets `pnpm check:templates` compile the built-in templates at all (it sat
    // at 193 `Cannot find name 'console'` errors, unrun by any workflow). The
    // declaration is only honest if the list is: a level here that QuickJS
    // never receives would compile a template that throws at runtime.
    const observed = await evalInSandbox(`
      (async () => ({
        keys: Object.keys(console).sort(),
        types: Object.keys(console).sort().map((k) => typeof console[k]),
      }))();
    `);

    expect(observed.keys).toEqual([...SANDBOX_CONSOLE_LEVELS].sort());
    expect(observed.types).toEqual(SANDBOX_CONSOLE_LEVELS.map(() => 'function'));
  }, 30_000);

  it('has no host globals the declaration would have to borrow a DOM lib for', async () => {
    // The reason `check:templates` declares `console` explicitly instead of
    // adding `"DOM"` to its `lib`: the DOM lib would also declare `document`,
    // `fetch` and `console.table`, none of which exist in here.
    const observed = await evalInSandbox(`
      (async () => ({
        absent: ['document', 'window', 'fetch', 'XMLHttpRequest', 'localStorage']
          .filter((name) => typeof globalThis[name] === 'undefined'),
        consoleTable: typeof console.table,
        globals: Object.getOwnPropertyNames(globalThis).filter((n) => n === 'bim' || n === 'console').sort(),
      }))();
    `);

    expect(observed.absent).toEqual(['document', 'window', 'fetch', 'XMLHttpRequest', 'localStorage']);
    expect(observed.consoleTable).toBe('undefined');
    expect(observed.globals).toEqual(['bim', 'console']);
  }, 30_000);
});
