/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { after, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PropertyValueType } from '@ifc-lite/data';
import { BulkActionConfig } from '@/components/viewer/bulk-property-editor-action-config.js';
import { cleanup, render } from '@/test/render.js';
import { closeContrastBrowser, measureTextContrastOnSurface, type Theme } from './render-harness.js';
import { WCAG_AA_NORMAL_TEXT } from './wcag.js';

afterEach(cleanup);
after(closeContrastBrowser);

describe('BulkActionConfig found-count contrast (#5812)', () => {
  for (const theme of ['light', 'dark', 'colorful'] as Theme[]) {
    it(`measures both rendered found-count annotations in ${theme}`, async () => {
      const container = render(<BulkActionConfig
        actionType="SET_PROPERTY"
        onActionTypeChange={() => {}}
        targetPset=""
        onTargetPsetChange={() => {}}
        targetProp=""
        onTargetPropChange={() => {}}
        targetValue=""
        onTargetValueChange={() => {}}
        valueType={PropertyValueType.String}
        onValueTypeChange={() => {}}
        psetOptions={['Pset_WallCommon']}
        propOptions={['FireRating', 'AcousticRating']}
      />);
      const annotations = [...container.querySelectorAll('span')].filter((span) =>
        span.childElementCount === 0 && /^\(\d+ found\)$/.test(span.textContent?.trim() ?? ''),
      );
      assert.equal(annotations.length, 2, 'both found-count annotations render');
      for (const annotation of annotations) {
        const ratio = await measureTextContrastOnSurface(theme, 'bg-background', annotation.className);
        assert.ok(ratio >= WCAG_AA_NORMAL_TEXT,
          `found-count contrast ${ratio.toFixed(2)}:1 falls below ${WCAG_AA_NORMAL_TEXT}:1 in ${theme}`);
      }
    });
  }
});
