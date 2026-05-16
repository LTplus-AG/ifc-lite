/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `useActionLogger` — bridge the viewer store to the extension action log.
 *
 * Subscribes to store transitions on a handful of key fields and emits
 * content-free `ActionEvent`s through `host.emitAction(...)`. The
 * miner consumes these to suggest one-click tools.
 *
 * Wired once at the top of the app (under `<ExtensionHostProvider>`).
 * Intentionally selective — we only log intents the miner can act on,
 * never raw payload content (no entity names, no chat text, no file
 * names). Per spec §06 §7, the action log NEVER sees user content.
 *
 * Spec: docs/architecture/ai-customization/06-self-improvement.md §2.
 */

import { useEffect } from 'react';
import { useOptionalExtensionHost } from '@/sdk/ExtensionHostProvider';
import { useViewerStore } from '@/store';

export function useActionLogger(): void {
  const host = useOptionalExtensionHost();

  useEffect(() => {
    if (!host) return;

    // Snapshot the prior state per field so we can detect transitions
    // rather than emit on every render. We use the public subscribe
    // method since the store is a vanilla zustand instance.
    let prev = useViewerStore.getState();

    const unsubscribe = useViewerStore.subscribe((state) => {
      // model.load / model.unload — compare by id, not by size, so a
      // simultaneous add+remove transition still emits the right events.
      for (const [id, model] of state.models) {
        if (!prev.models.has(id)) {
          host.emitAction('model.load', {
            schema: model.schemaVersion,
            entityCount: model.ifcDataStore?.entityCount,
            sizeBytes: model.fileSize,
          });
        }
      }
      for (const id of prev.models.keys()) {
        if (!state.models.has(id)) {
          host.emitAction('model.unload', {});
        }
      }

      // lens.apply / lens.clear — track active lens transitions.
      // Project the lens id through a short hash so a user-named lens
      // (e.g. "John's basement check") doesn't leak into the action
      // log. The pattern miner only needs identity for matching, not
      // the original string.
      if (state.activeLensId !== prev.activeLensId) {
        if (state.activeLensId) {
          host.emitAction('lens.apply', { id: hashLensId(state.activeLensId) });
        } else {
          host.emitAction('lens.clear', {});
        }
      }

      // selection.change — track selection count transitions.
      const prevCount = prev.selectedEntities?.length ?? 0;
      const nextCount = state.selectedEntities?.length ?? 0;
      if (prevCount !== nextCount) {
        host.emitAction('selection.change', { count: nextCount });
      }

      prev = state;
    });

    return unsubscribe;
  }, [host]);
}

/**
 * Project a lens id into a short stable token so the action log never
 * carries the original string. We only need identity for the miner;
 * djb2 is plenty for 30-50 distinct lenses per user.
 */
function hashLensId(id: string): string {
  let hash = 5381;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) + hash + id.charCodeAt(i)) | 0;
  }
  // Unsigned 32-bit hex — 8 chars, stable, opaque.
  return `lens-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}
