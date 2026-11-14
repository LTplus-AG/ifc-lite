/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * Move and Rotate in the Model workspace (#6232 C2): `element.move`,
 * `element.rotate`, their rail rows, keys and the selection handles that
 * stand in for the move gizmo there.
 */
export const moveRotateEn = {
  'moveRotate.mirror.label': "Mirror",
  'moveRotate.mirror.hintStart': "Click the first point of the mirror axis",
  'moveRotate.mirror.hintEnd': "Click the second axis point, or type an angle and Enter · Alt keeps the original",
  'moveRotate.mirror.keepOriginal': "Keep original",
  'moveRotate.offset.label': "Offset",
  'moveRotate.offset.hint': "Type a positive distance and click the side for the parallel copy",
  'moveRotate.offset.wallOnly': "Select one straight wall to offset",
  'commands.model.mirror': "Mirror the selection (Model workspace)",
  'commands.model.offset': "Offset a wall (Model workspace)",
  'moveRotate.move.label': 'Move',
  'moveRotate.move.hintBase': 'Click the point to move from, or type a distance',
  'moveRotate.move.hintTarget': 'Click where it goes, or type a distance and direction, then Enter',
  'moveRotate.rotate.label': 'Rotate',
  'moveRotate.rotate.hintStart': 'Click on the ring to start the turn, or type an angle · P picks another pivot',
  'moveRotate.rotate.hintAngle': 'Click to finish the turn (15° steps, Alt turns freely), or type an angle',
  'moveRotate.rotate.hintPivot': 'Click the point to turn about',
  'moveRotate.rotate.pivot': 'Pivot',
  'moveRotate.rotate.pivotTitle': 'Pick the point to turn about ({key})',
  'moveRotate.field.distance': 'Distance',
  'moveRotate.field.direction': 'Direction',
  'moveRotate.field.angle': 'Angle',
  'moveRotate.noSelection': 'Select what to move first',
  'moveRotate.refused': "Part of the selection can't move: its placement does not hang from its storey",
  'moveRotate.tool.move': 'Move',
  'moveRotate.tool.rotate': 'Rotate',
  'moveRotate.handle.move': 'Move the selection ({key})',
  'moveRotate.handle.rotate': 'Rotate the selection ({key})',
  'commands.model.move': 'Move the selection (Model workspace)',
  'commands.model.rotate': 'Rotate the selection (Model workspace)',
  'commands.command.rotatePivot': 'Pick the point to turn about (rotating)',
} as const satisfies Record<string, TranslationValue>;
