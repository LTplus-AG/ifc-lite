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

/** A slab seen from a corner: a thin plate, top and two edges. */
export const SlabIcon = createLucideIcon('model-slab', [
  ['path', { d: 'M2 14 8 8h14l-6 6z', key: 'top' }],
  ['path', { d: 'M2 14v3h14v-3', key: 'front' }],
  ['path', { d: 'M16 17l6-6V8', key: 'end' }],
]);

/** A column seen from a corner: a tall box on the floor. */
export const ColumnIcon = createLucideIcon('model-column', [
  ['path', { d: 'M8 6h6v15H8z', key: 'front' }],
  ['path', { d: 'm8 6 3-3h6l-3 3', key: 'top' }],
  ['path', { d: 'M17 3v15l-3 3', key: 'side' }],
]);

/** A beam seen from a corner: a long box lying across. */
export const BeamIcon = createLucideIcon('model-beam', [
  ['path', { d: 'M2 12h15v5H2z', key: 'front' }],
  ['path', { d: 'm2 12 5-5h15l-5 5', key: 'top' }],
  ['path', { d: 'M22 7v5l-5 5', key: 'end' }],
]);

/** A room in plan: four walls with a door opening and its leaf swinging in. */
export const RoomIcon = createLucideIcon('model-room', [
  ['path', { d: 'M14 21h7V3H3v18h5', key: 'walls' }],
  ['path', { d: 'M14 21v-6', key: 'leaf' }],
  ['path', { d: 'M8 21a6 6 0 0 1 6-6', key: 'swing' }],
]);
