/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { entityQueryTools } from './query.js';
import { queryRoomsTool } from './room-command.js';

/** The public read-only family includes entity discovery and native Room candidates. */
export const queryTools = [...entityQueryTools, queryRoomsTool];
