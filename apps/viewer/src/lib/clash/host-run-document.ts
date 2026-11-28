/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Turn a published clash result into the `ClashRunDocument` a registered host
 * listener receives (see `host-run-listeners.ts`). Runs only when a listener
 * is registered; a listener that throws is logged and never affects the
 * viewer or the other listeners.
 */

import {
  buildClashRunDocument,
  CLASH_RUN_BROWSER_SUBMITTED,
  type ClashResult,
  type ClashRunSlotBinding,
} from '@ifc-lite/clash';
import { clashRunRegistrations, type ClashRunListenerOptions } from './host-run-listeners';

interface ModelLike { id: string; name: string }

const buildInfo = () => ({
  version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : null,
  build: typeof __BUILD_SHA__ === 'string' ? __BUILD_SHA__ : null,
  backend: 'ts',
});

/** Slot bindings for every model the result references. */
export function slotBindings(result: ClashResult, models: ReadonlyMap<string, ModelLike>, options: ClashRunListenerOptions): ClashRunSlotBinding[] {
  const ids = new Set<string>();
  for (const clash of result.clashes) { ids.add(clash.a.model); ids.add(clash.b.model); }
  for (const coverage of result.ruleCoverage ?? []) for (const element of coverage.matchedElements ?? []) ids.add(element.model);
  return [...ids].sort().map((id) => {
    const name = models.get(id)?.name ?? id;
    const pinned = options.resolveSlot?.({ id, name }) ?? null;
    return pinned
      ? { model: id, slot: pinned.slot, sha256: pinned.sha256, name, ...(pinned.label !== undefined ? { label: pinned.label } : {}) }
      : { model: id, slot: id, sha256: null, name };
  });
}

/** Deliver a published result to every registered host listener. */
export function notifyClashRunComplete(result: ClashResult, models: ReadonlyMap<string, ModelLike>): void {
  for (const { listener, options } of clashRunRegistrations()) {
    try {
      const document = buildClashRunDocument({
        result,
        slots: slotBindings(result, models, options),
        engine: buildInfo(),
        ruleRevisions: options.ruleRevisions,
        labels: [CLASH_RUN_BROWSER_SUBMITTED],
      });
      listener({ document });
    } catch (err) {
      console.error('[clash] host run listener failed', err);
    }
  }
}
