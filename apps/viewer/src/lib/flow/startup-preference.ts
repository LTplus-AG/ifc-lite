/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { SavedFlow } from './persistence';
import { DEEP_LINK_PARAMS } from '../deep-links/artifact-link';

export const FLOW_STARTUP_KEY = 'ifc-lite:flow-startup-v1';
interface StartupPreference { version: 1; flowId: string }

/** Startup is an opt-in ID reference to a saved graph, never a serialized run. */
export function readStartupFlowId(storage: Pick<Storage, 'getItem'> = localStorage): string | null {
  try {
    const raw = storage.getItem(FLOW_STARTUP_KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    const preference = value as Partial<StartupPreference>;
    return preference.version === 1 && typeof preference.flowId === 'string'
      && preference.flowId.trim().length > 0 && preference.flowId.length <= 200 ? preference.flowId : null;
  } catch (error) {
    console.warn('[flow] could not read startup preference', error);
    return null;
  }
}

/** Writes throw: callers show a persistence error instead of pretending opt-in succeeded. */
export function saveStartupFlowId(flowId: string | null, storage: Pick<Storage, 'setItem' | 'removeItem'> = localStorage): void {
  if (flowId === null) storage.removeItem(FLOW_STARTUP_KEY);
  else {
    if (!flowId.trim() || flowId.length > 200) throw new Error('Invalid startup workflow ID.');
    storage.setItem(FLOW_STARTUP_KEY, JSON.stringify({ version: 1, flowId } satisfies StartupPreference));
  }
}

export function resolveStartupFlow(flows: readonly SavedFlow[], flowId: string | null): SavedFlow | null {
  return flowId === null ? null : flows.find((flow) => flow.doc.id === flowId) ?? null;
}

/** Explicit deep-link startup actions take priority over optional workflows. */
export function suppressStartupWorkflow(search: string): boolean {
  const params = new URLSearchParams(search);
  return ['model', 'room', 'tour', 'workflow', 'flow', ...DEEP_LINK_PARAMS].some((key) => params.has(key));
}
