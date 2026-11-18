/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The Properties panel's attribute list follows this session's edits, positional numeric ones included (#10659). */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { mergeAttributeMutations } from './overlayAttributes';

const SITE = [{ name: 'Name', value: 'Site' }, { name: 'RefElevation', value: 12 }];

it('shows a positional RefElevation edit and a named edit, and leaves list values to the Raw STEP tab', () => {
  const view = new MutablePropertyView(null, 'm');
  view.setPositionalAttribute(6, 11, { real: 540 });
  view.setPositionalAttribute(6, 9, [46, 56, 52, 0]);
  view.setAttribute(6, 'Name', 'Bern');
  assert.deepEqual(mergeAttributeMutations(SITE, view, 6, 'IfcSite'), [{ name: 'Name', value: 'Bern' }, { name: 'RefElevation', value: 540 }]);
});

it('returns the attributes unchanged without a view or edits', () => {
  assert.deepEqual(mergeAttributeMutations(SITE, null, 6, 'IfcSite'), SITE);
  assert.deepEqual(mergeAttributeMutations(SITE, new MutablePropertyView(null, 'm'), 6, 'IfcSite'), SITE);
});
