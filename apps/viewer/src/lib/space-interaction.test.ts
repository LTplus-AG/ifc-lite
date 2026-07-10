/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { pointerButton, isRemoveModifier } from './space-interaction.js';

describe('pointerButton', () => {
  it('names the standard buttons', () => {
    assert.strictEqual(pointerButton({ button: 0 }), 'primary');
    assert.strictEqual(pointerButton({ button: 1 }), 'middle');
    assert.strictEqual(pointerButton({ button: 2 }), 'secondary');
    assert.strictEqual(pointerButton({ button: 5 }), 'other');
  });
});

describe('isRemoveModifier', () => {
  const ev = (o: Partial<{ altKey: boolean; ctrlKey: boolean; metaKey: boolean }>) =>
    ({ altKey: false, ctrlKey: false, metaKey: false, ...o });

  it('is true for Alt, Ctrl, or Cmd held', () => {
    assert.strictEqual(isRemoveModifier(ev({ altKey: true })), true);
    assert.strictEqual(isRemoveModifier(ev({ ctrlKey: true })), true);
    assert.strictEqual(isRemoveModifier(ev({ metaKey: true })), true);
  });

  it('is false with no modifier (a plain click drags / draws)', () => {
    assert.strictEqual(isRemoveModifier(ev({})), false);
  });
});
