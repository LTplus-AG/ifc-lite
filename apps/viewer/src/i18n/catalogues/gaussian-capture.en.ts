/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * Gaussian capture models (#8565/#8566): the capture's metadata panel and its
 * single-model hierarchy row. Capture names and attributions are content, not
 * literals. The wording never claims units, alignment, measurement or release
 * qualification: captures are an internal, unqualified preview.
 */
export const gaussianCaptureEn = {
  'gaussianCapture.kind': 'Gaussian capture (internal preview)',
  'gaussianCapture.format.gaussianPly': 'Gaussian PLY',
  'gaussianCapture.format.splat': '.splat',
  'gaussianCapture.heading.capture': 'Capture',
  'gaussianCapture.heading.limitations': 'Limitations',
  'gaussianCapture.splats': 'Splats',
  'gaussianCapture.shDegree': 'Spherical harmonics degree',
  'gaussianCapture.placement': 'Placement',
  'gaussianCapture.placement.source': 'Raw source coordinates',
  'gaussianCapture.placement.explicit': 'Explicitly supplied placement',
  'gaussianCapture.calibration': 'Calibration',
  'gaussianCapture.calibration.uncalibrated': 'Uncalibrated: no units, alignment or measurement',
  'gaussianCapture.rendererState': 'Renderer state',
  'gaussianCapture.state.resident': 'Resident',
  'gaussianCapture.state.pending': 'Uploading',
  'gaussianCapture.state.failed': 'Failed: reload the capture',
  'gaussianCapture.state.invalid': 'Not on this renderer',
  'gaussianCapture.attribution': 'Attribution',
  'gaussianCapture.limitation.clipping': 'Section planes and boxes cull whole Gaussians by centre; no section caps.',
  'gaussianCapture.limitation.composition': 'Composited over IFC glass and X-ray approximately.',
  'gaussianCapture.limitation.picking': 'Not pickable: select the capture in the model list. No snapping or measurement.',
  'gaussianCapture.row.summary': { one: '{formatted} splat · uncalibrated', other: '{formatted} splats · uncalibrated' },
  'gaussianCapture.row.inspect': 'Show capture details',
  'gaussianCapture.row.hide': 'Hide capture',
  'gaussianCapture.row.show': 'Show capture',
  'gaussianCapture.row.fit': 'Fit capture in view',
  'gaussianCapture.row.remove': 'Remove capture',
} as const satisfies Record<string, TranslationValue>;
