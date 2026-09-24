/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5843: the page must stay zoomable (WCAG 1.4.4, axe `meta-viewport`).
 * `user-scalable=no` / `maximum-scale=1` stopped low-vision users from
 * enlarging panel text on a phone. A pinch on the MODEL is not the page's to
 * handle anyway: the viewport canvas sets `touch-action: none` and
 * `useTouchControls` cancels its touch events, so the 3D camera keeps the
 * gesture there. The embed reuses that same `Viewport`, so it is held to the
 * same rule.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ENTRY_POINTS = [
  join(process.cwd(), 'index.html'),
  join(process.cwd(), '..', 'viewer-embed', 'index.html'),
];

function viewportMeta(file: string): Map<string, string> {
  const html = readFileSync(file, 'utf8');
  const tag = /<meta\s+name="viewport"\s+content="([^"]*)"/i.exec(html);
  assert.ok(tag, `${file} has no viewport meta`);
  return new Map(tag[1].split(',').map((part) => {
    const [key, value = ''] = part.split('=').map((s) => s.trim().toLowerCase());
    return [key, value] as const;
  }));
}

describe('viewport meta keeps the page zoomable (#5843)', () => {
  for (const file of ENTRY_POINTS) {
    it(`${file.split('/apps/')[1]} allows user zoom`, () => {
      const meta = viewportMeta(file);
      const scalable = meta.get('user-scalable');
      assert.ok(scalable !== 'no' && scalable !== '0', `user-scalable=${scalable} blocks pinch-zoom`);
      const maxScale = meta.get('maximum-scale');
      assert.ok(maxScale === undefined || Number(maxScale) >= 5, `maximum-scale=${maxScale} caps zoom below 500%`);
      assert.equal(meta.get('width'), 'device-width');
    });
  }
});
