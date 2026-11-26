/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { configureOutOfCore, resetOutOfCoreArm } from './outOfCoreConfig.js';
import { activePerfFlags } from '../lib/perf/flags-applied.js';

const g = globalThis as Record<string, unknown>;

function setSearch(search: string): void {
  Object.defineProperty(globalThis, 'location', { value: { search }, configurable: true, writable: true });
}

afterEach(() => {
  delete g.__IFC_LITE_OOC;
  Reflect.deleteProperty(globalThis, 'location');
  resetOutOfCoreArm();
});

type Processor = { outOfCore?: boolean; onOutOfCoreDecision?: (ran: boolean) => void };
const ramp = (value: unknown) => (key: string) => (key === 'perf-ooc' ? value : undefined);
const primary = { primary: true, retry: false, isCurrent: () => true };

describe('out-of-core config', () => {
  it('leaves the processor unset with nothing on, so the pool reads the explicit flag itself', () => {
    const processor: Processor = {};
    configureOutOfCore(processor, primary, () => undefined);
    assert.equal(processor.outOfCore, undefined);
    configureOutOfCore(processor, primary, ramp(false));
    assert.equal(processor.outOfCore, undefined, 'a ramp that is off is not an explicit off');
  });

  it('hands a primary first attempt the perf-ooc ramp, under the explicit global and URL param', () => {
    const processor: Processor = {};
    configureOutOfCore(processor, primary, ramp(true));
    assert.equal(processor.outOfCore, true, 'the ramp alone reaches the processor');
    setSearch('?perf.ooc=0');
    configureOutOfCore(processor, primary, ramp(true));
    assert.equal(processor.outOfCore, undefined, 'the URL kill switch beats the ramp (the pool then reads it)');
    Reflect.deleteProperty(globalThis, 'location');
    g.__IFC_LITE_OOC = 1;
    configureOutOfCore(processor, primary, ramp(false));
    assert.equal(processor.outOfCore, true, 'the global beats a ramp that is off');
  });

  it('keeps the ramp off a resource retry and a federated add; the explicit flag still applies to both', () => {
    for (const options of [{ ...primary, retry: true }, { ...primary, primary: false }]) {
      const processor: Processor = {};
      configureOutOfCore(processor, options, ramp(true));
      assert.equal(processor.outOfCore, undefined, JSON.stringify(options));
      setSearch('?perf.ooc=1');
      configureOutOfCore(processor, options, ramp(true));
      assert.equal(processor.outOfCore, true, JSON.stringify(options));
      Reflect.deleteProperty(globalThis, 'location');
    }
  });

  it("reports the arm the primary load's pool ran, not the ramp value", () => {
    const processor: Processor = {};
    configureOutOfCore(processor, primary, ramp(true));
    assert.equal(activePerfFlags().outOfCore, undefined, 'before the pool reports, the default');
    processor.onOutOfCoreDecision?.(true);
    assert.equal(activePerfFlags().outOfCore, 'true');
    processor.onOutOfCoreDecision?.(false);
    assert.equal(activePerfFlags().outOfCore, undefined, 'a load the arena could not serve reports off');
    processor.onOutOfCoreDecision?.(true);
    resetOutOfCoreArm(); // the next primary load (a cache or server reopen reports nothing more)
    assert.equal(activePerfFlags().outOfCore, undefined, 'a new primary load starts from the default arm');
  });

  it('ignores a decision from a load that is no longer current', () => {
    let current = true;
    const processor: Processor = {};
    configureOutOfCore(processor, { ...primary, isCurrent: () => current }, ramp(true));
    current = false; // a newer primary load started (and reset the arm)
    processor.onOutOfCoreDecision?.(true);
    assert.equal(activePerfFlags().outOfCore, undefined);
  });

  it('leaves the arm to the primary for a federated add', () => {
    const processor: Processor = {};
    configureOutOfCore(processor, { ...primary, primary: false }, ramp(true));
    assert.equal(processor.onOutOfCoreDecision, undefined);
  });

  it('does not report a URL param that no pool load ran', () => {
    setSearch('?perf.ooc=1');
    assert.equal(activePerfFlags().outOfCore, undefined);
  });
});
