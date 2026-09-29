/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The viewer's built-in modeling commands (charter #6232, WP2), registered
 * once on import, and the session's workplane resolver. Imported by the command HUD row (`tool-hud-registry.ts`),
 * which every viewer mounts, and by tests that start a built-in command.
 */

import { getModelingCommand, registerModelingCommand, setWorkplaneResolver } from './registry.js';
import { buildStoreyWorkplane } from './workplane.js';
import { BEAM_PLACE } from './commands/beam-place.js';
import { COLUMN_PLACE } from './commands/column-place.js';
import { ELEMENT_SPLIT } from './commands/element-split.js';
import { ROOM_PLACE } from './commands/room-place.js';
import { DOOR_PLACE, OPENING_PLACE, WINDOW_PLACE } from './commands/hosted-place.js';
import { SLAB_PLACE } from './commands/slab-place.js';
import { WALL_MOVE_ENDPOINT } from './commands/wall-move-endpoint.js';
import { WALL_PLACE } from './commands/wall-place.js';
import { HOSTED_SLIDE } from './commands/hosted-slide.js';
import { PLAN_MOVE } from './commands/plan-move.js';
import { SPLIT_MULTI } from './commands/multi-split.js';
import type { ModelingCommand } from './types.js';

/** A re-evaluated module (dev HMR) finds its commands already registered. */
function registerOnce<G>(command: ModelingCommand<G>): void {
  if (!getModelingCommand(command.id)) registerModelingCommand(command);
}

registerOnce(ELEMENT_SPLIT);
registerOnce(WALL_PLACE);
registerOnce(WALL_MOVE_ENDPOINT);
registerOnce(SLAB_PLACE);
registerOnce(COLUMN_PLACE);
registerOnce(BEAM_PLACE);
registerOnce(ROOM_PLACE);
registerOnce(OPENING_PLACE);
registerOnce(DOOR_PLACE);
registerOnce(WINDOW_PLACE);
registerOnce(HOSTED_SLIDE);
registerOnce(PLAN_MOVE);
registerOnce(SPLIT_MULTI);

setWorkplaneResolver((s, modelId, spec) => (spec.kind === 'storey'
  ? buildStoreyWorkplane(s, modelId, spec.storeyId, spec.offset)
  : { refused: 'Section workplanes are not supported yet.' }));
