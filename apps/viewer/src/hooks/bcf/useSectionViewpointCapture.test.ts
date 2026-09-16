/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sectionCaptureBlockReason, type SectionCaptureState } from './useSectionViewpointCapture';

const READY: SectionCaptureState = {
  panelVisible: true,
  status: 'ready',
  hasDrawing: true,
  canvasMounted: true,
  editingText: false,
  customPlane: false,
};

describe('sectionCaptureBlockReason (#4802)', () => {
  it('names a specific reason for each blocking condition', () => {
    assert.equal(sectionCaptureBlockReason(READY), null);
    assert.equal(sectionCaptureBlockReason({ ...READY, panelVisible: false }), 'Open the 2D section panel to capture it.');
    assert.equal(sectionCaptureBlockReason({ ...READY, status: 'generating' }), 'The 2D section is still generating.');
    assert.equal(sectionCaptureBlockReason({ ...READY, hasDrawing: false }), 'The 2D section is still generating.');
    assert.equal(sectionCaptureBlockReason({ ...READY, canvasMounted: false }), 'The 2D section is still generating.');
    assert.equal(sectionCaptureBlockReason({ ...READY, status: 'error' }), 'The 2D section failed to generate.');
    assert.equal(sectionCaptureBlockReason({ ...READY, editingText: true }), 'Finish editing text in the 2D section first.');
    assert.equal(sectionCaptureBlockReason({ ...READY, customPlane: true }), 'Custom section planes cannot be captured in 2D yet.');
    // A custom plane is not fixed by opening the panel, so it wins.
    assert.equal(
      sectionCaptureBlockReason({ ...READY, customPlane: true, panelVisible: false }),
      'Custom section planes cannot be captured in 2D yet.',
    );
  });
});
