/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { MutablePropertyView } from './mutable-property-view.js';

describe('setAttribute and the exporter\'s reserved NUL', () => {
  it('refuses a value that leads with NUL, which the exporter reserves for georeferencing text edits', () => {
    const view = new MutablePropertyView(null, 'model');
    expect(() => view.setAttribute(5, 'Description', '\u0000#5')).toThrow(/NUL/);
    expect(view.getAttributeMutationsForEntity(5)).toEqual([]);
    expect(() => view.setAttribute(5, 'Description', 'a\u0000b')).not.toThrow();
  });
});
