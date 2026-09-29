/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Rail glyphs for the Stair and Railing tools (charter #6232, D1), built like
 * the other element tools' (`model-icons.ts`) on lucide's 24-unit grid.
 */

import { createLucideIcon } from 'lucide-react';

/** A flight of four steps seen from the side. */
export const StairIcon = createLucideIcon('model-stair', [
  ['path', { d: 'M3 21h4v-5h4v-5h4V6h6', key: 'steps' }],
  ['path', { d: 'M3 21h18', key: 'floor' }],
]);

/** A handrail on three posts. */
export const RailingIcon = createLucideIcon('model-railing', [
  ['path', { d: 'M3 8h18', key: 'rail' }],
  ['path', { d: 'M5 8v13', key: 'post-a' }],
  ['path', { d: 'M12 8v13', key: 'post-b' }],
  ['path', { d: 'M19 8v13', key: 'post-c' }],
  ['path', { d: 'M3 21h18', key: 'floor' }],
]);
