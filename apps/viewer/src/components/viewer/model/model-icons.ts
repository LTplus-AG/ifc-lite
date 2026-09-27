/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Glyphs for the Model tool rail's element tools (charter #6232, M2) that
 * lucide does not ship. Built with `createLucideIcon` so they share lucide's
 * 24-unit grid, 2-unit stroke and props with the lucide glyphs beside them
 * (Select, Split, Leave); the `@/icons` house set is drawn at the ribbon's
 * lighter weight and would read thinner in the rail.
 */

import { createLucideIcon } from 'lucide-react';

/** A wall seen from a corner: front face, top and end, with brick courses. */
export const WallIcon = createLucideIcon('model-wall', [
  ['path', { d: 'M2 9h15v12H2z', key: 'front' }],
  ['path', { d: 'm2 9 5-5h15l-5 5', key: 'top' }],
  ['path', { d: 'M22 4v12l-5 5', key: 'end' }],
  ['path', { d: 'M2 15h15', key: 'course' }],
  ['path', { d: 'M8 9v6', key: 'joint-a' }],
  ['path', { d: 'M11 15v6', key: 'joint-b' }],
]);
