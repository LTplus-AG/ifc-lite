/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { configureOutOfCore, resetOutOfCoreArm } from './outOfCoreConfig.js';
import { activePerfFlags, recordAppliedPerfFlag } from '../lib/perf/flags-applied.js';

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

describe('out-of-core config', () => {
  it('is off with nothing set', () => {
    const processor: Processor = {};
    configureOutOfCore(processor, { recordArm: true }, () => undefined);
    assert.equal(processor.outOfCore, false);
  });

  it('follows the perf-ooc PostHog ramp, under the explicit global and URL param', () => {
    const processor: Processor = {};
    configureOutOfCore(processor, { recordArm: true }, ramp(true));
    assert.equal(processor.outOfCore, true, 'the ramp alone reaches the processor');
    setSearch('?perf.ooc=0');
    configureOutOfCore(processor, { recordArm: true }, ramp(true));
    assert.equal(processor.outOfCore, false, 'the URL kill switch beats the ramp');
    Reflect.deleteProperty(globalThis, 'location');
    g.__IFC_LITE_OOC = 1;
    configureOutOfCore(processor, { recordArm: true }, ramp(false));
    assert.equal(processor.outOfCore, true, 'the global beats a ramp that is off');
  });

  it("reports the arm the primary load's pool ran, not the ramp value", () => {
    const processor: Processor = {};
    configureOutOfCore(processor, { recordArm: true }, ramp(true));
    assert.equal(activePerfFlags().outOfCore, undefined, 'before the pool reports, the default');
    processor.onOutOfCoreDecision?.(true);
    assert.equal(activePerfFlags().outOfCore, 'true');
    processor.onOutOfCoreDecision?.(false);
    assert.equal(activePerfFlags().outOfCore, undefined, 'a load the arena could not serve reports off');
  });

  it('leaves the arm to the primary for a federated add', () => {
    const processor: Processor = {};
    configureOutOfCore(processor, { recordArm: false }, ramp(true));
    assert.equal(processor.outOfCore, true);
    assert.equal(processor.onOutOfCoreDecision, undefined);
  });

  it('starts every primary load from the default arm', () => {
    recordAppliedPerfFlag('outOfCore', true);
    assert.equal(activePerfFlags().outOfCore, 'true');
    resetOutOfCoreArm();
    assert.equal(activePerfFlags().outOfCore, undefined);
  });

  it('does not report a URL param that no pool load ran', () => {
    // The module starts with the arm recorded as off: a session that never loads through the pool reports the default.
    setSearch('?perf.ooc=1');
    assert.equal(activePerfFlags().outOfCore, undefined);
  });
});
