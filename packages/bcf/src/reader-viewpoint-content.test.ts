/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { parseViewpointContent } from './reader-viewpoint-content.js';

function viewpointWithBitmapHeight(height: string): string {
  return `<VisualizationInfo Guid="00000000-0000-0000-0000-000000000001">
    <Bitmaps><Bitmap>
      <Format>PNG</Format>
      <Reference>bitmap.png</Reference>
      <Location><X>0</X><Y>0</Y><Z>0</Z></Location>
      <Normal><X>0</X><Y>0</Y><Z>1</Z></Normal>
      <Up><X>0</X><Y>1</Y><Z>0</Z></Up>
      <Height>${height}</Height>
    </Bitmap></Bitmaps>
  </VisualizationInfo>`;
}

describe('bitmap height parsing', () => {
  it.each(['NaN', 'Infinity', '-Infinity'])(
    'drops a bitmap whose height is the non-finite value %s (#3970)',
    (height) => {
      const viewpoint = parseViewpointContent(viewpointWithBitmapHeight(height), '3.0');
      expect(viewpoint?.bitmaps).toBeUndefined();
    },
  );

  it('preserves a finite bitmap height', () => {
    const viewpoint = parseViewpointContent(viewpointWithBitmapHeight('2.5'), '3.0');
    expect(viewpoint?.bitmaps?.[0]?.height).toBe(2.5);
  });
});
