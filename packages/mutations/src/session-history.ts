/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { cooperativeOverlay } from './cooperative-overlay-access.js';
import type { MutablePropertyView } from './mutable-property-view.js';
import { generateMutationId, type Mutation } from './types.js';

/** Record a local domain edit in ordinary Undo order without fabricating IFC changes. */
export function recordSessionMutation(view: MutablePropertyView, entityId: number, kind: string): Mutation {
  if (!Number.isSafeInteger(entityId) || entityId <= 0 || typeof kind !== 'string' || !kind.trim() || kind.length > 128) {
    throw new Error('Session history requires a positive entity context and a bounded domain label');
  }
  const access = cooperativeOverlay(view), state = access.capture();
  const mutation: Mutation = { id: generateMutationId(), type: 'SESSION_EDIT', timestamp: Date.now(), modelId: access.modelId, entityId, sessionKind: kind };
  state.mutationHistory.push(mutation);
  access.publish(state);
  return mutation;
}
