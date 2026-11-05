/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * Gaussian capture models (#8565/#8566/#8568): the capture's metadata panel,
 * its single-model hierarchy row, load refusals and the export notice. Capture
 * names and attributions are content, not literals. The wording never claims
 * units, alignment or measurement: captures are uncalibrated.
 */
export const gaussianCaptureEn = {
  'gaussianCapture.kind': 'Gaussian capture',
  'gaussianCapture.format.gaussianPly': 'Gaussian PLY',
  'gaussianCapture.format.splat': '.splat',
  'gaussianCapture.heading.capture': 'Capture',
  'gaussianCapture.heading.limitations': 'Limitations',
  'gaussianCapture.upAxis': 'Source up-axis',
  'gaussianCapture.upAxis.z': 'Z up (like scans)',
  'gaussianCapture.upAxis.y': 'Y up',
  'gaussianCapture.upAxis.failed': 'Could not change capture orientation. Check the capture renderer state.',
  'gaussianCapture.splats': 'Splats',
  'gaussianCapture.shDegree': 'Spherical harmonics degree',
  'gaussianCapture.placement': 'Placement',
  'gaussianCapture.placement.source': 'Source coordinates in viewer frame',
  'gaussianCapture.placement.explicit': 'Explicitly supplied placement',
  'gaussianCapture.calibration': 'Calibration',
  'gaussianCapture.calibration.uncalibrated': 'Uncalibrated: no units, alignment or measurement',
  'gaussianCapture.rendererState': 'Renderer state',
  'gaussianCapture.state.resident': 'Resident',
  'gaussianCapture.state.pending': 'Waiting for the graphics device',
  'gaussianCapture.state.failedReload': 'Upload failed. Reload the capture.',
  'gaussianCapture.state.failedAnchor': 'Its placement exceeds the renderer-coordinate limit of 8,192 from the shared Gaussian anchor, so it is no longer drawn. Fix the model placement, then reload the capture.',
  'gaussianCapture.state.failedOther': 'Failed ({reason}). Reload the capture.',
  'gaussianCapture.state.replaced': 'The viewer renderer restarted. Reload the capture.',
  'gaussianCapture.state.invalid': 'Not on this renderer. Reload the capture.',
  'gaussianCapture.scale': 'Scale',
  'gaussianCapture.scale.unknown': 'Unknown: source units, not metres',
  'gaussianCapture.scale.captureOnly': 'Uncalibrated capture: no metric scale.',
  'gaussianCapture.scale.mixed': 'Scale applies to IFC geometry. Captures are uncalibrated.',
  'gaussianCapture.attribution': 'Attribution',
  'gaussianCapture.limitation.clipping': 'Section planes and boxes cull whole Gaussians by centre; no section caps.',
  'gaussianCapture.limitation.composition': 'Exact behind one glass layer; approximate behind several layers and in X-ray.',
  'gaussianCapture.limitation.picking': 'Not pickable: select the capture in the model list.',
  'gaussianCapture.limitation.measurement': 'No measurement or snapping on captures.',
  'gaussianCapture.limitation.uncalibrated': 'Uncalibrated: shown in source units, with no metric scale or survey alignment.',
  'gaussianCapture.limitation.export': 'Capture data is not included in exports (IFC, glTF, USD, KMZ, PDF and others). BCF snapshots can show visible captures.',
  'gaussianCapture.error.disabled': 'Gaussian capture loading is turned off in this viewer build. IFC models and point clouds still load.',
  'gaussianCapture.error.captureBytes': 'This capture is {size}. Gaussian captures can be at most {limit}.',
  'gaussianCapture.error.captureSplats': 'This capture has {count} splats. A scene can hold at most {limit} splats.',
  'gaussianCapture.error.shDegree': 'This capture uses spherical harmonics degree {degree}. Degree {limit} or lower is supported.',
  'gaussianCapture.error.sceneSplats': 'Opening this capture would bring the scene to {total} splats, over the {limit} limit. Remove a capture, then try again.',
  'gaussianCapture.error.deviceLost': 'The graphics device was lost; reload the page and open the capture again.',
  'gaussianCapture.error.rendererUnavailable': 'The viewer renderer cannot accept Gaussian captures right now; the capture was not decoded.',
  'gaussianCapture.error.loadFailed': 'Gaussian capture could not be loaded: {reason}',
  'gaussianCapture.error.webgpu': 'Gaussian captures need the WebGPU 3D view, which is not available here. The capture was not decoded.',
  'gaussianCapture.export.notice': { one: '{formatted} Gaussian capture is loaded. Capture data is not included in exports. BCF snapshots can show visible captures.', other: '{formatted} Gaussian captures are loaded. Capture data is not included in exports. BCF snapshots can show visible captures.' },
  'gaussianCapture.row.summary': { one: '{formatted} splat · uncalibrated', other: '{formatted} splats · uncalibrated' },
  'gaussianCapture.row.inspect': 'Show capture details',
  'gaussianCapture.row.hide': 'Hide capture',
  'gaussianCapture.row.show': 'Show capture',
  'gaussianCapture.row.fit': 'Fit capture in view',
  'gaussianCapture.row.remove': 'Remove capture',
  'gaussianCapture.row.reload': 'Reload capture',
  'gaussianCapture.reload.sourceUnavailable': 'The capture file is no longer available. Open it again.',
  'gaussianCapture.reload.notLoaded': 'The capture did not load again.',
} as const satisfies Record<string, TranslationValue>;
