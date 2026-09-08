/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Dropping a BCF archive onto the main viewport used to fail with no
 * feedback at all (issue #4099): `.bcfzip` matches neither
 * `isSupportedModelFile` (it's not a model) nor the `.zip` branch of
 * `describeUnsupportedFormat` (the string "bcfzip" has no literal dot
 * before "zip", so `endsWith('.zip')` is false), so
 * `ViewportContainer.handleDrop` found no explanation to show and the drop
 * silently did nothing. See the reporter's own confusion in the issue:
 * "Maybe it should be unzipped? Isn't it .bcf format?"
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { describeUnsupportedFormat } from './unsupportedFormat.js';

describe('describeUnsupportedFormat for BCF archives (#4099)', () => {
  it('explains a dropped .bcfzip instead of matching nothing', () => {
    const message = describeUnsupportedFormat('clash-report.bcfzip');
    assert.notEqual(message, null);
    assert.match(message!, /BCF/);
    assert.match(message!, /BCF panel/i);
  });

  it('explains a dropped .bcf too', () => {
    const message = describeUnsupportedFormat('topics.bcf');
    assert.notEqual(message, null);
    assert.match(message!, /BCF/);
  });

  it('does not misclassify a BCF archive as a generic ZIP', () => {
    // A regular ZIP still gets the "extract first" guidance; a BCF archive
    // must not fall through to that message instead of its own.
    const message = describeUnsupportedFormat('clash-report.bcfzip');
    assert.doesNotMatch(message!, /extract first/i);
  });
});
