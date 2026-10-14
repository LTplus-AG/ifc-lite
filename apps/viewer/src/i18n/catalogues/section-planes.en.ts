/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/** The Section tool's cutting-plane set (#7545): chips, the Add menu, the plane menu and Undo. */
export const sectionPlanesEn = {
  'sectionPlanes.chipsAria': 'Cutting planes',
  'sectionPlanes.chipCutting': 'Plane {name}: cutting',
  'sectionPlanes.chipPreview': 'Plane {name}: preview, not cutting',
  'sectionPlanes.add': 'Add plane',
  'sectionPlanes.addTitle': 'Add a cutting plane',
  'sectionPlanes.addLimit': 'At most {max} planes',
  'sectionPlanes.empty': 'Add a plane:',
  'sectionPlanes.addDown': 'Down (Z)',
  'sectionPlanes.addFront': 'Front (Y)',
  'sectionPlanes.addSide': 'Side (X)',
  'sectionPlanes.addFace': 'Face…',
  'sectionPlanes.addBox': 'Box',
  'sectionPlanes.addAlignment': 'Alignment…',
  'sectionPlanes.menu.aria': 'Actions for plane {name}',
  'sectionPlanes.menu.rename': 'Rename',
  'sectionPlanes.menu.direction': 'Direction of this plane',
  'sectionPlanes.menu.cut': 'Cut',
  'sectionPlanes.menu.show': 'Show plane',
  'sectionPlanes.menu.duplicate': 'Duplicate',
  'sectionPlanes.menu.remove': 'Remove',
  'sectionPlanes.menu.clearAll': 'Clear all',
  'sectionPlanes.rename.aria': 'Plane name',
  'sectionPlanes.undo.removed': 'Removed plane {name}',
  'sectionPlanes.undo.cleared': 'Cleared all planes',
  'sectionPlanes.undo.action': 'Undo',
  'sectionPlanes.hint.empty': 'Add a plane to start cutting · Esc to finish',
  'sectionPlanes.hint.addPick': 'Click a face to cut through it · Esc cancels',
  'sectionPlanes.parked.count': '{count} cuts',
} as const satisfies Record<string, TranslationValue>;
