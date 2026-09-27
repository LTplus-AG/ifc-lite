/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The storey pill and the hidden/ghosted count moved from `ViewportOverlays`
 * into `StatusBar` (#5504, charter #5478 item 22), off the shared
 * `useViewportStatusSummary` derivation. This is the non-federated,
 * single-model coverage; `ViewportOverlays.federation.test.tsx` covers the
 * cross-model storey-name and live-edit regressions the same readouts had
 * before the move.
 */

import '@/test/setup-dom.js';
// `__APP_VERSION__` is a vite `define` (see vite.config.ts) baked in at
// build time; under plain Node it doesn't exist, so StatusBar's footer
// version string needs a stand-in before it renders.
(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '0.0.0-test';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { createBimContext } from '@ifc-lite/sdk';
import { useViewerStore } from '@/store/index.js';
import { registerLocale, setLocale } from '@/i18n';
import { ExtensionHostService } from '@/services/extensions/host.js';
import { ExtensionHostContext } from '@/sdk/ExtensionHostProvider.js';
import { render, cleanup } from '@/test/render.js';
import { StatusBar } from './StatusBar.js';
import { guid } from './anonymized-export/anonymized-export-fixture.test-support.js';

const FIXTURE = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('viewport-status-fixture.ifc','2020-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('${guid(1)}',$,'Project',$,$,$,$,$,$);
#2=IFCSITE('${guid(2)}',$,'Site',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);
#3=IFCBUILDING('${guid(3)}',$,'Building',$,$,$,$,$,.ELEMENT.,$,$,$);
#4=IFCBUILDINGSTOREY('${guid(4)}',$,'Ground Floor',$,$,$,$,$,$,0.);
#5=IFCWALL('${guid(5)}',$,'Wall A',$,$,$,$,$,$);
#6=IFCWALL('${guid(6)}',$,'Wall B',$,$,$,$,$,$);
#10=IFCRELAGGREGATES('${guid(10)}',$,$,$,#1,(#2));
#11=IFCRELAGGREGATES('${guid(11)}',$,$,$,#2,(#3));
#12=IFCRELAGGREGATES('${guid(12)}',$,$,$,#3,(#4));
#13=IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid(13)}',$,$,$,(#5,#6),#4);
ENDSEC;
END-ISO-10303-21;
`;

const stubHost = new ExtensionHostService({
  sdk: createBimContext({
    transport: {
      send: () => Promise.reject(new Error('SDK transport is not exercised by this test')),
      subscribe: () => () => {},
      close: () => {},
    },
  }),
});

async function parseFixture(): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(FIXTURE);
  return new IfcParser().parseColumnar(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
}

function renderStatusBar(): HTMLElement {
  return render(
    <ExtensionHostContext.Provider value={stubHost}>
      <StatusBar />
    </ExtensionHostContext.Provider>,
  );
}

afterEach(() => {
  cleanup();
  setLocale('en');
});

describe('StatusBar — storey pill and hidden count (#5504)', () => {
  beforeEach(async () => {
    const store = await parseFixture();
    useViewerStore.setState({
      ifcDataStore: store,
      geometryResult: null,
      activeModelId: null,
      models: new Map(),
      selectedStoreys: new Set<number>(),
      hiddenEntities: new Set<number>(),
      isolatedEntities: null,
      classFilter: null,
      ghostExceptEntities: null,
      mutationViews: new Map(),
      mutationVersion: 0,
      showPerformanceStats: false,
    });
  });

  it('shows no storey pill or hidden count on an unfiltered model', () => {
    const container = renderStatusBar();
    assert.doesNotMatch(container.textContent ?? '', /Ground Floor/);
    assert.doesNotMatch(container.textContent ?? '', /hidden/);
  });

  it('keeps diagnostic readouts and the FPS loop off until enabled (#5868)', () => {
    const originalRequestFrame = globalThis.requestAnimationFrame;
    let requestedFrames = 0;
    globalThis.requestAnimationFrame = (callback) => {
      requestedFrames++;
      return originalRequestFrame(callback);
    };
    try {
      const container = renderStatusBar();
      assert.match(container.textContent ?? '', /elements/);
      assert.doesNotMatch(container.textContent ?? '', /FPS|tris/);
      assert.equal(requestedFrames, 0);

      act(() => useViewerStore.getState().setShowPerformanceStats(true));
      assert.match(container.textContent ?? '', /FPS|tris/);
      assert.ok(requestedFrames > 0, 'enabling stats starts FPS sampling');
      assert.equal(localStorage.getItem('ifc-lite:show-performance-stats'), 'true');

      act(() => useViewerStore.getState().setShowPerformanceStats(false));
      assert.doesNotMatch(container.textContent ?? '', /FPS|tris/);
    } finally {
      globalThis.requestAnimationFrame = originalRequestFrame;
    }
  });

  it('names the selected storey', () => {
    act(() => useViewerStore.setState({ selectedStoreys: new Set([4]) }));
    const container = renderStatusBar();
    assert.match(container.textContent ?? '', /Ground Floor/);
  });

  it('reports the hidden count, passive and singular-correct', () => {
    act(() => useViewerStore.setState({ hiddenEntities: new Set([5]) }));
    const container = renderStatusBar();
    assert.match(container.textContent ?? '', /1 hidden/);
    assert.doesNotMatch(container.textContent ?? '', /ghosted/);
  });

  it('reports both hidden and ghosted counts together', () => {
    act(() => useViewerStore.setState({
      hiddenEntities: new Set([5]),
      ghostExceptEntities: new Set<number>(),
    }));
    const container = renderStatusBar();
    assert.match(container.textContent ?? '', /1 hidden/);
    assert.match(container.textContent ?? '', /1 ghosted/);
  });

  it('translates the hidden count through the catalogue, not a hardcoded literal', () => {
    act(() => useViewerStore.setState({ hiddenEntities: new Set([5]) }));
    registerLocale('statusbar-hidden-de', { 'shellChrome.statusBar.hiddenCount': '{count} ausgeblendet' });
    act(() => setLocale('statusbar-hidden-de'));
    const container = renderStatusBar();
    assert.match(container.textContent ?? '', /1 ausgeblendet/);
    assert.doesNotMatch(container.textContent ?? '', /1 hidden/);
  });
});
