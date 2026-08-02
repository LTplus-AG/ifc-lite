/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { PropertyValueType } from '@ifc-lite/data';
import { useViewerStore } from '@/store/index.js';
import type { ChangedModelsResult } from '@/lib/export/model-changes.js';
import { ExportChangesReviewDialog, buildReviewGroups } from './ExportChangesReviewDialog.js';

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

function renderDialog(props: {
  changed: ChangedModelsResult;
  totalCount: number;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
}): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  // The dialog is a pure display of `groups` (issue #1915 follow-up: review
  // and export could diverge) — build it the same way `ExportChangesButton`
  // does, from the live `mutationViews` map, rather than passing `changed`
  // straight through.
  const groups = buildReviewGroups(useViewerStore.getState().mutationViews, props.changed);
  act(() => {
    root.render(
      <ExportChangesReviewDialog
        open
        onOpenChange={props.onOpenChange}
        groups={groups}
        totalCount={props.totalCount}
        isExporting={false}
        onConfirm={props.onConfirm}
      />,
    );
  });
  mounted.push({ root, container });
  return container;
}

/** Radix portals `DialogContent` into `document.body`, not the render container (mirrors HbjsonExportDialog.test.tsx). */
function dialogText(): string {
  return document.body.textContent ?? '';
}

function findButton(label: string): HTMLButtonElement {
  const btn = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.includes(label));
  assert.ok(btn, `button "${label}" must render`);
  return btn;
}

describe('ExportChangesReviewDialog (issue #1915)', () => {
  beforeEach(() => {
    for (const { root, container } of mounted.splice(0)) {
      act(() => {
        root.unmount();
      });
      container.remove();
    }
    useViewerStore.setState({ mutationViews: new Map() });
  });

  it('renders one row per effective change, grouped by model then entity, with previous -> new values', async () => {
    const view = new MutablePropertyView(null, 'model-1');
    view.setOnDemandExtractor((entityId) => entityId === 7 ? [{
      name: 'Pset_Base',
      globalId: 'g',
      properties: [{ name: 'Status', type: PropertyValueType.Label, value: 'Original' }],
    }] : []);
    view.setProperty(7, 'Pset_Base', 'Status', 'Edited', PropertyValueType.Label);
    useViewerStore.setState({ mutationViews: new Map([['model-1', view]]) });

    const changed: ChangedModelsResult = {
      models: [{
        id: 'model-1',
        name: 'model-1.ifc',
        schemaVersion: 'IFC4',
        ifcDataStore: null,
        changeCount: 1,
        isScheduleTarget: false,
      }],
      scheduleTargetModelId: null,
    };

    await act(async () => {
      renderDialog({ changed, totalCount: 1, onConfirm: () => {}, onOpenChange: () => {} });
    });

    const text = dialogText();
    assert.ok(text.includes('model-1.ifc'), 'model name heading renders');
    assert.ok(text.includes('#7'), 'entity id renders');
    assert.ok(text.includes('Property: Pset_Base.Status'), 'change kind + pset.property renders');
    assert.ok(text.includes('Original'), 'previous value renders');
    assert.ok(text.includes('Edited'), 'new value renders');
  });

  it('shows the honest empty state when there are no pending changes, not a table implying changes exist', async () => {
    const changed: ChangedModelsResult = { models: [], scheduleTargetModelId: null };

    await act(async () => {
      renderDialog({ changed, totalCount: 0, onConfirm: () => {}, onOpenChange: () => {} });
    });

    const text = dialogText();
    assert.ok(
      text.includes('No pending changes to export.') && text.includes('Nothing has changed since the last export'),
      'empty-state copy renders',
    );
    assert.ok(!text.includes('Property:'), 'no change rows render when there are none');
  });

  it('invokes onConfirm exactly once when the dialog Export button is clicked', async () => {
    const view = new MutablePropertyView(null, 'model-1');
    view.setAttribute(1, 'Name', 'New Name');
    useViewerStore.setState({ mutationViews: new Map([['model-1', view]]) });

    const changed: ChangedModelsResult = {
      models: [{ id: 'model-1', name: 'model-1.ifc', schemaVersion: 'IFC4', ifcDataStore: null, changeCount: 1, isScheduleTarget: false }],
      scheduleTargetModelId: null,
    };
    const onConfirm = mock.fn();
    const onOpenChange = mock.fn();

    await act(async () => {
      renderDialog({ changed, totalCount: 1, onConfirm, onOpenChange });
    });

    const exportButton = findButton('Export');
    await act(async () => {
      exportButton.click();
    });

    assert.equal(onConfirm.mock.callCount(), 1, 'onConfirm fires exactly once');
  });

  it('does not invoke onConfirm when Cancel is clicked, and closes instead', async () => {
    const view = new MutablePropertyView(null, 'model-1');
    view.setAttribute(1, 'Name', 'New Name');
    useViewerStore.setState({ mutationViews: new Map([['model-1', view]]) });

    const changed: ChangedModelsResult = {
      models: [{ id: 'model-1', name: 'model-1.ifc', schemaVersion: 'IFC4', ifcDataStore: null, changeCount: 1, isScheduleTarget: false }],
      scheduleTargetModelId: null,
    };
    const onConfirm = mock.fn();
    const onOpenChange = mock.fn();

    await act(async () => {
      renderDialog({ changed, totalCount: 1, onConfirm, onOpenChange });
    });

    const cancelButton = findButton('Cancel');
    await act(async () => {
      cancelButton.click();
    });

    assert.equal(onConfirm.mock.callCount(), 0, 'onConfirm never fires from Cancel');
    assert.equal(onOpenChange.mock.callCount(), 1, 'onOpenChange(false) fires from Cancel');
    assert.equal(onOpenChange.mock.calls[0].arguments[0], false);
  });

  it('shows the "not itemized" summary line only when the badge count exceeds the itemizable overlay changes', async () => {
    // The view carries exactly ONE overlay change (Name), but the model entry
    // reports THREE — the +2 stands in for georef/schedule contributions
    // collectChangedModels folds into the same badge count (see model-changes.ts).
    const view = new MutablePropertyView(null, 'model-1');
    view.setAttribute(1, 'Name', 'New Name');
    useViewerStore.setState({ mutationViews: new Map([['model-1', view]]) });

    const changedWithExtra: ChangedModelsResult = {
      models: [{ id: 'model-1', name: 'model-1.ifc', schemaVersion: 'IFC4', ifcDataStore: null, changeCount: 3, isScheduleTarget: true }],
      scheduleTargetModelId: 'model-1',
    };

    await act(async () => {
      renderDialog({ changed: changedWithExtra, totalCount: 3, onConfirm: () => {}, onOpenChange: () => {} });
    });

    assert.ok(
      dialogText().includes('+ 2 georeferencing / schedule changes (not itemized above)'),
      'summary line reports the un-itemized delta',
    );
  });

  it('omits the "not itemized" summary line when the badge count matches the itemized changes exactly', async () => {
    const view = new MutablePropertyView(null, 'model-1');
    view.setAttribute(1, 'Name', 'New Name');
    useViewerStore.setState({ mutationViews: new Map([['model-1', view]]) });

    const changedExact: ChangedModelsResult = {
      models: [{ id: 'model-1', name: 'model-1.ifc', schemaVersion: 'IFC4', ifcDataStore: null, changeCount: 1, isScheduleTarget: false }],
      scheduleTargetModelId: null,
    };

    await act(async () => {
      renderDialog({ changed: changedExact, totalCount: 1, onConfirm: () => {}, onOpenChange: () => {} });
    });

    assert.ok(!dialogText().includes('not itemized above'), 'no summary line when nothing is left un-itemized');
  });
});
