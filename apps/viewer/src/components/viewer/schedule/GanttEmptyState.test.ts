/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { emptyStateHelperText } from './GanttEmptyState.js';

// The empty state renders whenever EITHER action is available
// (`(canGenerate && onGenerate) || onImport`), so each button can be absent
// independently. The helper text must name only what was rendered: promising
// a button that is not on screen sends the user looking for it.
describe('emptyStateHelperText', () => {
  it('describes both actions when both are available', () => {
    const text = emptyStateHelperText(true, true);
    assert.match(text, /Build a schedule/);
    assert.match(text, /import one from MS Project/);
  });

  it('omits the import clause when there is no import action', () => {
    // Reachable: a caller that wires up generation but no file picker still
    // renders the empty state via the `canGenerate && onGenerate` arm.
    const text = emptyStateHelperText(true, false);
    assert.match(text, /Build a schedule/);
    assert.doesNotMatch(text, /import/i);
  });

  it('omits the generate clause when the model cannot be generated from', () => {
    // Reachable: `canGenerate` is false for a model with no spatial
    // hierarchy, while the import action is still offered.
    const text = emptyStateHelperText(false, true);
    assert.doesNotMatch(text, /Build a schedule/);
    assert.match(text, /^Import one from MS Project/);
  });

  it('ends every variant as a single sentence', () => {
    for (const [canGenerate, canImport] of [[true, true], [true, false], [false, true]] as const) {
      const text = emptyStateHelperText(canGenerate, canImport);
      assert.ok(text.endsWith('.'), `expected a full stop, got: ${text}`);
      assert.strictEqual(text.split('.').length - 1, 1, `expected one sentence, got: ${text}`);
    }
  });
});
