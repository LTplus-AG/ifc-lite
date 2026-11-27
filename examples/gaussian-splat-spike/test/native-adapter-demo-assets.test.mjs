/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { version } from '@playcanvas/splat-transform';
import * as assets from '../contract/native-adapter-demo-assets.mjs';

test('demo status names the loaded capture decoder and reader (#11686)', () => {
  assert.equal(
    assets.captureDecodeStatus?.({ id: 'seem-kirke-v1', format: 'ply' }),
    `Decoding seem-kirke-v1 with @playcanvas/splat-transform ${version} (ply reader)…`,
  );
});
