/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState } from 'react';
import { evaluateWhen, parseWhen, type DockContribution, type SlotContribution } from '@ifc-lite/extensions';
import { useSlotContributions } from '@/hooks/useSlotContributions';
import { useOptionalExtensionHost } from '@/sdk/ExtensionHostProvider';
import { useViewerStore } from '@/store';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
import { useTranslation } from '@/i18n';
import type { PaletteAvailability } from '@/components/viewer/palette-availability';
import type { Command } from '@/components/viewer/commandPaletteSearch';
import { resolveExtensionIcon } from './icon-registry';
import { ExtensionDockBody } from './ExtensionDockBody';

/** Stable owner-qualified destinations share the real dock body on every layout.
 * The dialog lives outside the palette popup, including after its row closes it.
 */
export function useExtensionDockDestinations() {
  const { t } = useTranslation();
  const host = useOptionalExtensionHost();
  const currentHost = useRef(host);
  currentHost.current = host;
  useEffect(() => { currentHost.current = host; return () => { currentHost.current = null; }; }, [host]);
  const left = useSlotContributions<DockContribution>('dock.left');
  const right = useSlotContributions<DockContribution>('dock.right');
  const bottom = useSlotContributions<DockContribution>('dock.bottom');
  // Subscribe to the same context used by the normal dock, while checks read
  // the live store again during deferred activation and widget interaction.
  useViewerStore(s => s.models.size);
  useViewerStore(s => s.selectedEntityIds.size);
  const [request, setRequest] = useState<{
    contribution: SlotContribution<DockContribution>;
    check: () => PaletteAvailability;
    launcher: HTMLElement | null;
  } | null>(null);
  const commands: Command[] = [...left, ...right, ...bottom].map<Command>(contribution => {
    const { payload, extensionId } = contribution;
    const check = (): PaletteAvailability => {
      if (!host || currentHost.current !== host) return { status: 'disabled', reasonKey: 'commandPalette.availability.host' };
      if (!host.slotRegistry.getAll(contribution.slot).includes(contribution)) return { status: 'disabled', reasonKey: 'commandPalette.availability.feature' };
      if (payload.when) {
        const parsed = parseWhen(payload.when);
        const s = useViewerStore.getState();
        if (!parsed.ok || !evaluateWhen(parsed.value, { 'model.loaded': s.models.size > 0, 'selection.count': s.selectedEntityIds.size })) {
          return { status: 'disabled', reasonKey: 'commandPalette.extension.conditions' };
        }
      }
      return { status: 'available' };
    };
    return {
      id: `ext-widget:${encodeURIComponent(JSON.stringify([extensionId, contribution.slot, payload.id]))}`,
      runtimeSource: 'extension-widget', label: payload.title, category: 'Extensions',
      detail: `${extensionId} · ${contribution.slot}${payload.when ? ` · ${payload.when}` : ''}`,
      keywords: `${extensionId} ${payload.id} ${payload.title} extension widget panel tool dock werkzeug панель инструмент`,
      icon: resolveExtensionIcon(payload.icon), availability: check(), checkAvailability: check,
      action: () => {
        const availability = check();
        if (availability.status === 'disabled') { toast.info(t(availability.reasonKey)); return; }
        setRequest({ contribution, check, launcher: document.activeElement instanceof HTMLElement ? document.activeElement : null });
      },
    };
  });
  const availability = request?.check();
  const dialog = request ? <Dialog open onOpenChange={open => { if (!open) setRequest(null); }}>
    <DialogContent className="flex max-h-[85dvh] w-[calc(100%-2rem)] flex-col overflow-auto"
      onCloseAutoFocus={event => { event.preventDefault(); if (request.launcher?.isConnected) request.launcher.focus(); }}>
      <DialogTitle>{request.contribution.payload.title}</DialogTitle>
      <DialogDescription>{request.contribution.extensionId}</DialogDescription>
      {availability?.status === 'disabled'
        ? <p role="alert">{t(availability.reasonKey)}</p>
        : <ExtensionDockBody contribution={request.contribution} beforeCommand={() => {
          const live = request.check();
          if (live.status === 'disabled') { toast.info(t(live.reasonKey)); return false; }
          return true;
        }} />}
    </DialogContent>
  </Dialog> : null;
  return { commands, dialog };
}
