/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The "Show unclassified" toggle in the auto-color lens editor
 * (`AutoColorEditor`, classification source only) is the only UI path to
 * `AutoColorSpec.includeUnclassified` — the engine half of this feature
 * (#unclassified-bucket) already ships absence legend buckets, but nothing
 * in the panel could set the flag.
 *
 * The trap this guards against: a toggle whose `onChange` fires and flips
 * local component state proves nothing about whether the flag actually
 * reaches the engine — a mocked setter can be "called" while the field it
 * writes is never read by anything downstream (see #camera= URL param, shipped
 * the same day this test was written). So this test does not stop at
 * asserting the checkbox's onChange ran: it captures the `Lens` object
 * `AutoColorEditor` hands to `onSave`, feeds its `autoColor` straight into
 * `@ifc-lite/lens`'s real `evaluateAutoColorLens`, and asserts on the
 * resulting legend — the same function `useLens` calls to render the panel.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup, click } from '@/test/render.js';
import { evaluateAutoColorLens } from '@ifc-lite/lens';
import type { LensDataProvider } from '@ifc-lite/lens';
import { AutoColorEditor } from './LensPanel.js';
import type { Lens, DiscoveredLensData } from '@/store/slices/lensSlice';

const discovered: DiscoveredLensData = {
  classes: [],
  propertySets: null,
  quantitySets: null,
  classificationSystems: ['NL-SfB tabel 1'],
  materials: null,
};

/** Two entities classified in the target system, two unclassified. */
function makeProvider(): LensDataProvider {
  return {
    getEntityCount: () => 4,
    forEachEntity: (cb) => { for (const id of [1, 2, 3, 4]) cb(id, 'model-1'); },
    getEntityType: () => 'IfcWall',
    getPropertyValue: () => undefined,
    getPropertySets: () => [],
    getClassifications: (id: number) => {
      if (id === 1 || id === 2) {
        return [{ system: 'NL-SfB tabel 1', code: `21.${id}`, name: undefined }];
      }
      return [];
    },
  };
}

describe('AutoColorEditor - "Show unclassified" toggle wires includeUnclassified to the engine', () => {
  afterEach(cleanup);

  it('is absent for a non-classification source', () => {
    const container = render(
      <AutoColorEditor
        initial={{ name: 'By type', autoColor: { source: 'ifcType' } }}
        onSave={mock.fn()}
        onCancel={() => {}}
        discovered={discovered}
        onRequestDiscovery={() => {}}
      />,
    );
    assert.equal(container.textContent?.includes('Show unclassified'), false,
      'the toggle is meaningless outside source: classification and must not render for other sources');
  });

  it('appears for a classification source and, when off, the saved spec omits the flag entirely', () => {
    const onSave = mock.fn();
    const container = render(
      <AutoColorEditor
        initial={{ name: 'By class', autoColor: { source: 'classification', psetName: 'NL-SfB tabel 1' } }}
        onSave={onSave}
        onCancel={() => {}}
        discovered={discovered}
        onRequestDiscovery={() => {}}
      />,
    );
    assert.ok(container.textContent?.includes('Show unclassified'), 'the toggle must render for a classification source');

    const saveButton = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Save'));
    assert.ok(saveButton, 'a Save button must render');
    click(saveButton!);

    assert.equal(onSave.mock.callCount(), 1);
    const saved = onSave.mock.calls[0].arguments[0] as Lens;
    assert.equal(saved.autoColor?.includeUnclassified, undefined,
      'leaving the toggle off must reproduce the pre-existing spec shape exactly - no includeUnclassified key at all');
  });

  it('checking the toggle then saving produces a spec that makes the real engine emit absence legend buckets', () => {
    const onSave = mock.fn();
    const container = render(
      <AutoColorEditor
        initial={{ name: 'By class', autoColor: { source: 'classification', psetName: 'NL-SfB tabel 1' } }}
        onSave={onSave}
        onCancel={() => {}}
        discovered={discovered}
        onRequestDiscovery={() => {}}
      />,
    );

    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    assert.ok(checkbox, 'the "Show unclassified" checkbox must render');
    click(checkbox!);

    const saveButton = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Save'));
    click(saveButton!);

    assert.equal(onSave.mock.callCount(), 1);
    const saved = onSave.mock.calls[0].arguments[0] as Lens;
    assert.equal(saved.autoColor?.includeUnclassified, true,
      'checking the toggle must set includeUnclassified: true on the saved spec');

    // The observable effect: feed the UI-produced spec into the real engine
    // (not a mock) and check it actually changed evaluation, not just state.
    const result = evaluateAutoColorLens(saved.autoColor!, makeProvider());
    const noClassification = result.legend.find((e) => e.id === 'auto-absent-no-classification');
    assert.ok(noClassification, 'the engine must emit a "No classification" legend entry from the UI-produced spec');
    assert.equal(noClassification!.name, 'No classification');
    assert.equal(noClassification!.count, 2);
    assert.equal(noClassification!.isAbsent, true);
    assert.equal(result.colorMap.get(3)?.[3], 1, 'an absence-bucket entity must get a real opaque color, not the ghost tint');
  });
});
