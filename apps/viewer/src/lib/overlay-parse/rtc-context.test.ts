/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';
import type { IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { overlayRtcContextFor } from './rtc-context.js';

const originalState = useViewerStore.getState();
const store = (name: string) => ({ name }) as unknown as IfcDataStore;
const coordinateInfo = (wasmRtcFrame: { x: number; y: number; z: number; needsShift: boolean }) => ({
  coordinateInfo: { wasmRtcFrame },
}) as never;

beforeEach(() => {
  useViewerStore.setState({
    models: new Map(),
    ifcDataStore: null,
    geometryResult: null,
    loading: false,
  });
});

after(() => useViewerStore.setState(originalState, true));

describe('overlay RTC context ownership (#4799)', () => {
  it('uses the exact frame owned by the matching store and never a sibling frame', () => {
    const target = store('target');
    const sibling = store('sibling');
    useViewerStore.setState({
      models: new Map([
        ['sibling', {
          ifcDataStore: sibling,
          geometryResult: coordinateInfo({ x: 999, y: 999, z: 999, needsShift: true }),
          loadState: 'complete',
        } as never],
        ['target', {
          ifcDataStore: target,
          geometryResult: coordinateInfo({ x: 10, y: 20, z: 30, needsShift: false }),
          loadState: 'complete',
        } as never],
      ]),
    });

    assert.deepEqual(overlayRtcContextFor(target), {
      mode: 'explicit',
      key: 'explicit:10,20,30,false',
      frame: { x: 10, y: 20, z: 30, needsShift: false },
    });
  });

  it('distinguishes pending metadata from completed provenance absence', () => {
    const target = store('target');
    useViewerStore.setState({
      models: new Map([['target', {
        ifcDataStore: target,
        geometryResult: null,
        loadState: 'streaming-geometry',
      } as never]]),
    });
    assert.deepEqual(overlayRtcContextFor(target), { mode: 'pending' });

    useViewerStore.setState({
      models: new Map([['target', {
        ifcDataStore: target,
        geometryResult: null,
        loadState: 'complete',
      } as never]]),
    });
    assert.deepEqual(overlayRtcContextFor(target), {
      mode: 'standalone',
      key: 'standalone',
      frame: undefined,
    });
  });

  it('keys every frame field, false versus absent, and signed zero', () => {
    const target = store('target');
    const setFrame = (x: number, needsShift: boolean) => useViewerStore.setState({
      models: new Map([['target', {
        ifcDataStore: target,
        geometryResult: coordinateInfo({ x, y: 2, z: 3, needsShift }),
        loadState: 'complete',
      } as never]]),
    });

    setFrame(0, false);
    const positiveZero = overlayRtcContextFor(target);
    setFrame(-0, false);
    const negativeZero = overlayRtcContextFor(target);
    setFrame(-0, true);
    const shifted = overlayRtcContextFor(target);

    assert.equal(positiveZero.mode === 'explicit' && positiveZero.key, 'explicit:0,2,3,false');
    assert.equal(negativeZero.mode === 'explicit' && negativeZero.key, 'explicit:-0,2,3,false');
    assert.equal(shifted.mode === 'explicit' && shifted.key, 'explicit:-0,2,3,true');
  });

  it('uses primary-model loading as pending until its exact frame is published', () => {
    const target = store('primary');
    useViewerStore.setState({ ifcDataStore: target, loading: true });
    assert.deepEqual(overlayRtcContextFor(target), { mode: 'pending' });

    useViewerStore.setState({
      loading: false,
      geometryResult: coordinateInfo({ x: 1, y: 2, z: 3, needsShift: true }),
    });
    assert.equal(overlayRtcContextFor(target).mode, 'explicit');
  });
});
