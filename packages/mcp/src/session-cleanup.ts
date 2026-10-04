/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Logger, ModelRegistry } from './context.js';
import { disposeLayerWorkspace } from './tools/layer-store.js';
import type { ViewerManager } from './viewer-manager.js';

/** A failed session resource must not prevent disposal of the other models. */
export function disposeSessionResources(viewer: ViewerManager, registry: ModelRegistry, sessionId: string | undefined, logger: Logger): void {
  const failures: { context: string; error: unknown }[] = [];
  const attempt = (context: string, dispose: () => void) => {
    try { dispose(); } catch (error) { failures.push({ context, error }); }
  };
  attempt('viewer', () => { if (viewer.isOpen()) viewer.close(); });
  if (sessionId !== undefined) attempt(`layer workspace ${sessionId}`, () => disposeLayerWorkspace(sessionId));
  for (const model of registry.list()) attempt(`model ${model.id}`, () => model.backend.dispose());
  const errors = failures.map(failure => failure.error);
  for (const { context, error } of failures) {
    try { logger.log('error', `Session cleanup failed for ${context}`, { error: error instanceof Error ? error.message : String(error) }); }
    catch (loggingError) { errors.push(loggingError); }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Session cleanup failed');
}
