/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Hosted placement uses the viewer/CLI SDK factory (#6232 D5). One compound
 * creation is one undo operation, even though it writes many IFC records. */
import { createModellingStoreBackend, type ModellingStoreModelResolver } from '@ifc-lite/sdk';
import type { MutablePropertyView } from '@ifc-lite/mutations';

const groups = new WeakMap<MutablePropertyView, Map<string, string>>();

export function createHostedStoreBackend(resolve: ModellingStoreModelResolver) {
  const methods = createModellingStoreBackend(resolve);
  function record<T>(modelId: string, edit: () => T): T {
    const view = resolve(modelId).mutationView;
    const before = new Set(view.getMutations().map(m => m.id));
    const result = edit();
    const written = view.getMutations().filter(m => !before.has(m.id));
    let tags = groups.get(view);
    if (!tags) groups.set(view, tags = new Map());
    const batch = written[0]?.id;
    if (batch) for (const mutation of written) tags.set(mutation.id, batch);
    return result;
  }
  return {
    addOpening: (...args: Parameters<typeof methods.addOpening>) => record(args[0], () => methods.addOpening(...args)),
    addHostedDoor: (...args: Parameters<typeof methods.addHostedDoor>) => record(args[0], () => methods.addHostedDoor(...args)),
    addHostedWindow: (...args: Parameters<typeof methods.addHostedWindow>) => record(args[0], () => methods.addHostedWindow(...args)),
  };
}

/** Expand the last N operations into raw history entries, preserving the
 * existing one-entry undo behavior for mutations outside a hosted commit. */
export function undoMutationCount(view: MutablePropertyView, n: number): number {
  const history = view.getMutations();
  const tags = groups.get(view);
  let index = history.length;
  for (let step = 0; step < n && index > 0; step++) {
    index--;
    const batch = tags?.get(history[index].id);
    if (batch) while (index > 0 && tags?.get(history[index - 1].id) === batch) index--;
  }
  return history.length - index;
}
