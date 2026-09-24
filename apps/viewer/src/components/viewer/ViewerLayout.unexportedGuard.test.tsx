/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5604: closing the tab with unexported edits discarded them silently; the
 * only `beforeunload` listener closed pop-out windows. The viewer shell now
 * cancels the unload (so the browser asks the user) exactly while the Export
 * Changes count is above zero.
 */

import '@/test/setup-dom.js';
(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '0.0.0-test';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { PropertyValueType } from '@ifc-lite/data';
import type { BimContext } from '@ifc-lite/sdk';
import { createBimContext } from '@ifc-lite/sdk';
import { BimReactContext } from '@/sdk/BimProvider.js';
import { ExtensionHostContext } from '@/sdk/ExtensionHostProvider.js';
import { ExtensionHostService } from '@/services/extensions/host.js';
import { SourceHostProvider } from '@/services/sources/SourceHostProvider.js';
import { cleanup, render } from '@/test/render.js';
import { useViewerStore } from '@/store';
import type { FederatedModel } from '@/store/types';
import { ViewerLayout } from './ViewerLayout.js';

const MODEL_ID = 'model-a';

/** A loaded model with no data store, as in `ViewerLayout.i18n.test.tsx`: the
 *  change count reads only the model's mutation view. */
function makeModel(): FederatedModel {
  return {
    id: MODEL_ID,
    name: `${MODEL_ID}.ifc`,
    ifcDataStore: null,
    geometryResult: null,
    visible: true,
    collapsed: false,
    schemaVersion: 'IFC4',
    loadedAt: 1,
    fileSize: 3,
    idOffset: 0,
    maxExpressId: 0,
  };
}

/** Same stub-host seam as `ViewerLayout.i18n.test.tsx`. */
class StubExtensionHost extends ExtensionHostService {
  constructor() {
    super({
      sdk: createBimContext({
        transport: {
          send: () => Promise.reject(new Error('SDK transport is not exercised by this test')),
          subscribe: () => () => {},
          close: () => {},
        },
      }),
    });
  }
}

function renderLayout(): void {
  render(
    <BimReactContext.Provider value={{} as BimContext}>
      <ExtensionHostContext.Provider value={new StubExtensionHost()}>
        <SourceHostProvider>
          <ViewerLayout />
        </SourceHostProvider>
      </ExtensionHostContext.Provider>
    </BimReactContext.Provider>,
  );
}

/** Dispatch a real `beforeunload`; true when a listener asked the browser to confirm. */
function unloadIsBlocked(): boolean {
  const event = new window.Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

describe('ViewerLayout — unexported-edits unload guard (#5604)', () => {
  beforeEach(() => {
    useViewerStore.setState({
      models: new Map([[MODEL_ID, makeModel()]]),
      isMobile: false,
      leftPanelCollapsed: true,
      rightPanelCollapsed: true,
      mutationViews: new Map(),
      mutationVersion: 0,
      georefMutations: new Map(),
      scheduleData: null,
      scheduleIsEdited: false,
      scheduleSourceModelId: null,
    });
  });

  afterEach(() => {
    cleanup();
    useViewerStore.setState({ models: new Map(), mutationViews: new Map() });
  });

  it('asks before unloading only while there are unexported changes', () => {
    renderLayout();
    assert.equal(unloadIsBlocked(), false, 'no changes: the page unloads freely');

    const view = new MutablePropertyView(null, MODEL_ID);
    view.setProperty(1, 'Pset_WallCommon', 'FireRating', 'REI60', PropertyValueType.Label);
    act(() => {
      useViewerStore.setState((s) => ({ mutationViews: new Map([[MODEL_ID, view]]), mutationVersion: s.mutationVersion + 1 }));
    });
    assert.equal(unloadIsBlocked(), true, 'an unexported change must make the browser ask before unloading');

    act(() => {
      useViewerStore.setState((s) => ({ mutationViews: new Map(), mutationVersion: s.mutationVersion + 1 }));
    });
    assert.equal(unloadIsBlocked(), false, 'once the changes are gone the guard is removed');
  });
});
