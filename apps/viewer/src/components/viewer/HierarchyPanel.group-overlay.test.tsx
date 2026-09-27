/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';
installLayout();

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { render, click, cleanup } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { SourceHostProvider } from '@/services/sources/SourceHostProvider';
import { HierarchyPanel } from './HierarchyPanel.js';

const FIXTURE = `ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#10=IFCWALL('0Wall00000000000000010',$,'Wall',$,$,$,$,$,$);
#11=IFCSPACE('0Space00000000000011',$,'Space',$,$,$,$,$,$,$);
#20=IFCGROUP('0Grp000000000000000020',$,'Edited group',$,$);
#21=IFCRELASSIGNSTOGROUP('0Rel000000000000000021',$,$,$,(#10),$,#20);
ENDSEC;
END-ISO-10303-21;
`;

afterEach(cleanup);

describe('HierarchyPanel group click over the edited model (#5249, #5885)', () => {
  it('selects a hidden space added by a rewritten assignment without changing its visibility', async () => {
    const dataStore = await new IfcParser().parseColumnar(
      new TextEncoder().encode(FIXTURE).buffer as ArrayBuffer,
      { disableWorkerScan: true },
    );
    const view = new MutablePropertyView(null, 'legacy');
    view.setAttribute(21, 'RelatedObjects', '#11');
    useViewerStore.setState((state) => ({
      ifcDataStore: dataStore,
      geometryResult: null,
      models: new Map(),
      mutationViews: new Map([['legacy', view]]),
      mutationVersion: state.mutationVersion + 1,
      hierarchyMode: 'groups',
      typeVisibility: { ...state.typeVisibility, spaces: false },
    }));

    const panel = render(<SourceHostProvider><HierarchyPanel /></SourceHostProvider>);
    const group = [...panel.querySelectorAll<HTMLElement>('.hierarchy-item')]
      .find((row) => row.textContent?.includes('Edited group'));
    assert.ok(group, 'the group row is rendered from the edited model');
    click(group);

    const state = useViewerStore.getState();
    assert.equal(state.selectedEntityIds.has(11), true,
      'clicking the group selects the space from its rewritten assignment');
    assert.equal(state.typeVisibility.spaces, false,
      'ordinary row activation leaves the hidden-space visibility policy unchanged');
  });
});
