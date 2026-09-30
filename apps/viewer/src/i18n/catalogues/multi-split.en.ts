/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * `split.multi` (charter #6232, C5): one cut line through every selected
 * element, or every wall, beam and slab of the storey. Why an element cannot
 * split is the Split button's own catalogue (`splitTool.unavailable.*`).
 */
export const multiSplitEn = {
  'multiSplit.label': 'Split by line',
  'multiSplit.tool': 'Split by line',
  'commands.model.splitMulti': 'Split everything along a line (Model workspace)',
  'multiSplit.hintStart': 'Click the first point of the cut line · the selection, or the storey, splits along it · Esc leaves',
  'multiSplit.hintEnd': 'Click the second point or press Enter to split what the line crosses · Backspace starts the line again · Esc starts over',
  'multiSplit.noTargets': 'Nothing to split here: select elements, or pick a storey with walls, beams or slabs',
  'multiSplit.needLine': 'Draw the cut line first: two points',
  'multiSplit.crossesNothing': 'The line crosses nothing it can split',
  'multiSplit.nothingSplittable': 'Everything the line crosses is refused: nothing would split',
  'multiSplit.scope.selection': {
    one: 'Selected: {countDisplay} element',
    other: 'Selected: {countDisplay} elements',
  },
  'multiSplit.scope.storey': {
    one: 'Storey: {countDisplay} wall, beam or slab',
    other: 'Storey: {countDisplay} walls, beams and slabs',
  },
  'multiSplit.bar.splits': {
    one: '{countDisplay} will split',
    other: '{countDisplay} will split',
  },
  'multiSplit.bar.refused': {
    one: '{countDisplay} refused',
    other: '{countDisplay} refused',
  },
  'multiSplit.refused.otherModel': 'Belongs to another model than the one being edited',
  'multiSplit.refused.column': "Can't split: a vertical cut does not cross a column lengthwise",
  'multiSplit.refused.vertical': "Can't split: a vertical member has no plan axis for the line to cross",
  'multiSplit.refused.nearEnd': "Can't split: the line crosses within {min} cm of an end",
  'multiSplit.done': {
    one: 'Split {countDisplay} element',
    other: 'Split {countDisplay} elements',
  },
  'multiSplit.leftAlone': {
    one: '{countDisplay} element the line crosses was left as it was (see the reason beside it)',
    other: '{countDisplay} elements the line crosses were left as they were (see the reason beside each)',
  },
  'multiSplit.openingsSkipped': {
    one: '{countDisplay} opening could not be reassigned and may need manual repositioning',
    other: '{countDisplay} openings could not be reassigned and may need manual repositioning',
  },
  'commandPalette.tool.splitMulti.label': 'Split by line',
} as const satisfies Record<string, TranslationValue>;
