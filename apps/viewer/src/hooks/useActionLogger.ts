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
import type { ActionIntent, ActionParams } from '@ifc-lite/extensions';
import { useOptionalExtensionHost } from '@/sdk/ExtensionHostProvider';
import { useViewerStore } from '@/store';

/**
 * Shape we read from the viewer store. Narrowed to just the fields
 * `detectActions` consumes so the function is unit-testable without
 * importing the full store type.
 */
export interface ActionLoggerStateShape {
  models: ReadonlyMap<string, { schemaVersion: string; ifcDataStore: { entityCount?: number } | null; fileSize: number }>;
  activeLensId: string | null;
  selectedEntities: readonly unknown[];
  sectionPlane?: { enabled?: boolean };
  drawing2DPanelVisible?: boolean;
}

export type EmittedAction = {
  [K in ActionIntent]: { intent: K; params: ActionParams[K] };
}[ActionIntent];

/**
 * Pure transition detector. Given the prior and next store states,
 * returns the list of action events to emit. Extracted so the
 * transition logic can be tested without a React renderer.
 */
export function detectActions(
  prev: ActionLoggerStateShape,
  state: ActionLoggerStateShape,
): EmittedAction[] {
  const out: EmittedAction[] = [];
  // model.load / model.unload — compare by id so a swap (same size)
  // still emits both events.
  for (const [id, model] of state.models) {
    if (!prev.models.has(id)) {
      out.push({
        intent: 'model.load',
        params: {
          schema: model.schemaVersion,
          entityCount: model.ifcDataStore?.entityCount,
          sizeBytes: model.fileSize,
        },
      });
    }
  }
  for (const id of prev.models.keys()) {
    if (!state.models.has(id)) {
      out.push({ intent: 'model.unload', params: {} });
    }
  }
  // lens.apply / lens.clear — hashed id only.
  if (state.activeLensId !== prev.activeLensId) {
    if (state.activeLensId) {
      out.push({ intent: 'lens.apply', params: { id: hashLensId(state.activeLensId) } });
    } else {
      out.push({ intent: 'lens.clear', params: {} });
    }
  }
  // selection.change — count delta only.
  const prevCount = prev.selectedEntities?.length ?? 0;
  const nextCount = state.selectedEntities?.length ?? 0;
  if (prevCount !== nextCount) {
    out.push({ intent: 'selection.change', params: { count: nextCount } });
  }
  // section.apply — enable transition only.
  const prevSection = prev.sectionPlane?.enabled ?? false;
  const nextSection = state.sectionPlane?.enabled ?? false;
  if (!prevSection && nextSection) {
    out.push({ intent: 'section.apply', params: {} });
  }
  // view.change — 2d/3d mode flip (proxied via drawing2D panel).
  const prevMode = prev.drawing2DPanelVisible ? '2d' : '3d';
  const nextMode = state.drawing2DPanelVisible ? '2d' : '3d';
  if (prevMode !== nextMode) {
    out.push({ intent: 'view.change', params: { mode: nextMode } });
  }
  return out;
}

export function useActionLogger(): void {
  const host = useOptionalExtensionHost();

  useEffect(() => {
    if (!host) return;

    // Snapshot the prior state per field so we can detect transitions
    // rather than emit on every render. We use the public subscribe
    // method since the store is a vanilla zustand instance.
    let prev = useViewerStore.getState() as unknown as ActionLoggerStateShape;

    const unsubscribe = useViewerStore.subscribe((state) => {
      const next = state as unknown as ActionLoggerStateShape;
      for (const event of detectActions(prev, next)) {
        // Type system can't infer the discriminated union →
        // emitAction's generic together; cast is safe because
        // EmittedAction is built from ActionIntent + ActionParams.
        host.emitAction(event.intent, event.params as never);
      }
      prev = next;
    });

    return unsubscribe;
  }, [host]);
}

/**
 * Project a lens id into a short stable token so the action log never
 * carries the original string. We only need identity for the miner;
 * djb2 is plenty for 30-50 distinct lenses per user.
 */
export function hashLensId(id: string): string {
  let hash = 5381;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) + hash + id.charCodeAt(i)) | 0;
  }
  // Unsigned 32-bit hex — 8 chars, stable, opaque.
  return `lens-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}
