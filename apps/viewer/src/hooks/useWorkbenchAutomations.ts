/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef } from 'react';
import { evaluateWhen, parseWhen, type UiAutomation, type UiAutomationTrigger } from '@ifc-lite/extensions';
import { toast } from '@/components/ui/toast';
import { useOptionalExtensionHost } from '@/sdk/ExtensionHostProvider';
import { useViewerStore } from '@/store';

const RUN_GUARD_MS = 1_000;
const recentRuns = new Map<string, number>();

export function useWorkbenchAutomations() {
  const host = useOptionalExtensionHost();
  const automations = useViewerStore((s) => s.workbenchLayout.automations);
  const modelCount = useViewerStore((s) => s.models.size);
  const selectionCount = useViewerStore((s) => s.selectedEntityIds.size);
  const previousModelCount = useRef(modelCount);
  const previousSelectionCount = useRef(selectionCount);

  useEffect(() => {
    if (modelCount > 0 && previousModelCount.current === 0) {
      runAutomations('model.loaded', automations, host);
    }
    previousModelCount.current = modelCount;
  }, [automations, host, modelCount]);

  useEffect(() => {
    if (selectionCount !== previousSelectionCount.current) {
      runAutomations('selection.changed', automations, host);
    }
    previousSelectionCount.current = selectionCount;
  }, [automations, host, selectionCount]);
}

export function firePanelOpenedAutomation(panelId: string) {
  const state = useViewerStore.getState();
  const automations = state.workbenchLayout.automations.filter((automation) =>
    automation.enabled
    && automation.trigger.kind === 'panel.opened'
    && automation.trigger.panelId === panelId,
  );
  for (const automation of automations) runAutomation(automation, undefined, 'panel.opened');
}

function runAutomations(
  trigger: UiAutomationTrigger['kind'],
  automations: readonly UiAutomation[],
  host: ReturnType<typeof useOptionalExtensionHost>,
): void {
  for (const automation of automations) {
    if (!automation.enabled || automation.trigger.kind !== trigger) continue;
    if (!whenMatches(automation.when)) continue;
    runAutomation(automation, host, trigger);
  }
}

function runAutomation(automation: UiAutomation, host?: ReturnType<typeof useOptionalExtensionHost>, trigger = automation.trigger.kind): void {
  const state = useViewerStore.getState();
  const guardKey = `${automation.id}:${trigger}`;
  const now = Date.now();
  const last = recentRuns.get(guardKey) ?? 0;
  if (now - last < RUN_GUARD_MS) {
    appendRun(automation, trigger, 'skipped', 'Skipped to prevent rapid automation loop.');
    return;
  }
  recentRuns.set(guardKey, now);
  try {
    for (const action of automation.actions.slice(0, 12)) {
      if (action.kind === 'layout.openPanel') state.openWorkbenchPanel(action.panelId);
      else if (action.kind === 'layout.movePanel') state.moveWorkbenchPanel(action.panelId, action.zone);
      else if (action.kind === 'layout.collapse') state.setWorkbenchCollapsed(action.zone, action.collapsed);
      else if (action.kind === 'layout.applyMode') state.applyWorkbenchMode(action.modeId);
      else if (action.kind === 'toast.show') toast.info(action.message);
      else if (action.kind === 'command.run') void host?.runCommand(action.commandId);
    }
    appendRun(automation, trigger, 'success');
  } catch (err) {
    appendRun(automation, trigger, 'failed', err instanceof Error ? err.message : String(err));
  }
}

function appendRun(
  automation: UiAutomation,
  trigger: string,
  status: 'success' | 'failed' | 'skipped',
  message?: string,
) {
  useViewerStore.getState().appendWorkbenchAutomationRun({
    id: crypto.randomUUID(),
    automationId: automation.id,
    automationName: automation.name,
    trigger,
    status,
    message,
    createdAt: new Date().toISOString(),
  });
}

function whenMatches(when: string | undefined): boolean {
  if (!when) return true;
  const state = useViewerStore.getState();
  const parsed = parseWhen(when);
  if (!parsed.ok) return false;
  return evaluateWhen(parsed.value, {
    'model.loaded': state.models.size > 0,
    'model.count': state.models.size,
    'selection.count': state.selectedEntityIds.size,
    'viewer.open': true,
  });
}
