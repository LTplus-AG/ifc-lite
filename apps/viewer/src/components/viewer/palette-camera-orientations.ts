/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { CUBE_FACES, facesOfDirection, zonesForFace } from './viewcube-zones';

/** The six face presets already have canonical commands. Add each remaining
 * ViewCube destination once, even though several faces share its hit region. */
export const PALETTE_CAMERA_ORIENTATIONS = [...new Map(
  CUBE_FACES.flatMap(face => zonesForFace(face))
    .filter(zone => zone.kind !== 'face')
    .map(zone => [zone.key, {
      key: zone.key,
      faces: facesOfDirection(zone.direction),
      direction: zone.direction,
      kind: zone.kind,
    }] as const),
).values()];
