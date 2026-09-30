/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * Push / Pull and Align in the Model workspace (charter #6232, C4): pulling a
 * face of the selected element to change one dimension, and lining elements
 * up on an edge of a reference.
 */
export const pushPullAlignEn = {
  'commands.model.pushPull': 'Push or pull a face of the selected element (Model workspace)',
  'commands.model.align': 'Align elements on an edge of a reference (Model workspace)',
  'modelWorkspace.tool.pushPull': 'Push / Pull',
  'modelWorkspace.tool.align': 'Align',
  'modelWorkspace.blocked.pushPull': 'Select a wall, slab, column or beam to push or pull',

  'commandPalette.tool.pushPull.label': 'Push / Pull a face',
  'commandPalette.tool.align.label': 'Align elements',

  'pushPull.label': 'Push / Pull',
  'pushPull.field.size': 'Size',
  'pushPull.hint.noTarget': 'Select a wall, slab, column or beam to push or pull its faces.',
  'pushPull.hint.pick': 'Grab a face handle, then drag or type a size',
  'pushPull.hint.drag': 'Drag or type the size · click or Enter applies · Esc cancels',
  'pushPull.unchanged': 'The size did not change.',
  'pushPull.face.wallHeight': 'Wall height',
  'pushPull.face.wallThickness': 'Wall thickness',
  'pushPull.face.slabThickness': 'Slab thickness',
  'pushPull.face.length': 'Length',
  'pushPull.handleAria': 'Pull the {face}',
  'pushPull.bar.readout': '{face} {delta} m',
  'pushPull.bar.snapLevel': 'Snapped to a floor level',
  'pushPull.bar.snapStep': 'Snapped to a step',

  'align.label': 'Align',
  'align.hint.reference': 'Click the element the others line up on',
  'align.hint.targets': 'Click the elements to line up with it',
  'align.hint.commit': 'Enter aligns them · click an element to add or drop it · Esc starts over',
  'align.alreadyAligned': 'They are already aligned on this edge.',
  'align.mode.aria': 'Edge to align on',
  'align.mode.left': 'Left',
  'align.mode.centre': 'Centre',
  'align.mode.right': 'Right',
  'align.mode.top': 'Top',
  'align.mode.middle': 'Middle',
  'align.mode.bottom': 'Bottom',
  'align.bar.count': '{targets} picked · {moving} to move',
} as const satisfies Record<string, TranslationValue>;
