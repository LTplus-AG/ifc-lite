/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expect, test } from 'vitest';
import { MAX_3DM_BYTES, tooLarge3dmMessage } from './size.js';

test('a file just over the cap never reads as the cap', () => {
  // Rounded to the nearest MB this said "This file is 400 MB; the reader
  // handles up to 400 MB", over and at the limit in one sentence (#10037).
  expect(tooLarge3dmMessage(MAX_3DM_BYTES + 1024))
    .toBe('This file is 401 MB; the reader handles up to 400 MB. Split the model into smaller files in Rhino.');
});

test('a size well over the cap reads as itself, rounded up', () => {
  expect(tooLarge3dmMessage(1536 * 1024 * 1024)).toContain('This file is 1536 MB;');
});
