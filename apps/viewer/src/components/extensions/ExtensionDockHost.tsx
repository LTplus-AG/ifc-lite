/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ExtensionDockHost` — render dock panels contributed by extensions.
 *
 * Consumes `dock.left | dock.right | dock.bottom` slot contributions
 * and renders each as a tabbed panel. The body of each tab loads the
 * referenced widget JSON from the contributing bundle and renders it
 * via `WidgetRenderer`.
 *
 * Each dock slot is rendered separately so the caller can place them
 * around the viewport layout independently. Empty slots render
 * nothing (no chrome, no overhead).
 *
 * Spec: docs/architecture/ai-customization/03-ui-surface.md §3.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  parseWhen,
  evaluateWhen,
  type DockContribution,
  type SlotContribution,
  type WhenContext,
} from '@ifc-lite/extensions';
import { useSlotContributions } from '@/hooks/useSlotContributions';
import { useViewerStore } from '@/store';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { ExtensionDockBody } from './ExtensionDockBody';
import { useTranslation } from '@/i18n';

interface ExtensionDockHostProps {
  slot: DockContribution['slot'];
  /** Tailwind class to apply to the container. */
  className?: string;
}

function tabId(contribution: SlotContribution<DockContribution>): string {
  return `${contribution.extensionId}:${contribution.payload.id}`;
}

export function ExtensionDockHost({ slot, className }: ExtensionDockHostProps) {
  const { t } = useTranslation();
  const contributions = useSlotContributions<DockContribution>(slot);
  // Derive the when-clause context from live viewer state so
  // contributions can key on selection / model presence. Future
  // additions (schema, viewer.open, embed flag) thread through here.
  const modelLoaded = useViewerStore((s) => s.models.size > 0);
  // `selectedEntityIds` is the primary selection set — same source
  // `ExtensionToolbarSlot` reads, so `selection.count` evaluates
  // consistently across every extension surface.
  const selectionCount = useViewerStore((s) => s.selectedEntityIds.size);
  const whenContext = useMemo<WhenContext>(
    () => ({ 'model.loaded': modelLoaded, 'selection.count': selectionCount }),
    [modelLoaded, selectionCount],
  );
  const visible = useFiltered(contributions, whenContext);
  const [activeId, setActiveId] = useState<string | undefined>(visible[0] ? tabId(visible[0]) : undefined);

  useEffect(() => {
    if (!visible.find((v) => tabId(v) === activeId)) {
      setActiveId(visible[0] ? tabId(visible[0]) : undefined);
    }
  }, [visible, activeId]);

  if (visible.length === 0) return null;

  const active = visible.find((v) => tabId(v) === activeId) ?? visible[0];

  return (
    // Radix Tabs owns this root; keep the dock's existing labelled region.
    // eslint-disable-next-line jsx-a11y/prefer-tag-over-role
    <Tabs role="region" value={tabId(active)} onValueChange={setActiveId} className={cn('flex flex-col h-full border-t bg-background', className)} aria-label={t('extensionsFlavors.extensionDockHost.dockAriaLabel', { slot })}>
      <TabsList className="flex h-auto items-center justify-start gap-0 rounded-none border-b bg-transparent p-0 overflow-x-auto" aria-label={t('extensionsFlavors.extensionDockHost.dockAriaLabel', { slot })}>
        {visible.map((c) => {
          return (
            <TabsTrigger
              key={tabId(c)}
              value={tabId(c)}
              className="shrink-0 rounded-none px-3 py-1.5 text-xs font-medium border-b-2 border-transparent bg-transparent shadow-none transition-colors data-[state=active]:border-primary data-[state=active]:text-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
              title={`${c.payload.title} — ${c.extensionId}`}
            >
              {c.payload.title}
            </TabsTrigger>
          );
        })}
      </TabsList>
      <TabsContent value={tabId(active)} className="mt-0 flex-1 min-h-0">
        <ScrollArea className="h-full">
        {/* Keyed on the tab identity (same composite as the tab button
            above) so switching tabs remounts `DockBody` — and, inside
            it, `WidgetErrorBoundary` — instead of reusing the previous
            tab's component instance and its state. See
            `WidgetErrorBoundary`'s doc comment for why an unkeyed reuse
            here masks every later widget behind a stale crash. */}
          <ExtensionDockBody key={`${active.extensionId}:${active.payload.id}`} contribution={active} />
        </ScrollArea>
      </TabsContent>
    </Tabs>
  );
}

function useFiltered(
  contributions: SlotContribution<DockContribution>[],
  whenContext: WhenContext,
): SlotContribution<DockContribution>[] {
  return useMemo(() => {
    return contributions.filter((c) => {
      if (!c.payload.when) return true;
      const parsed = parseWhen(c.payload.when);
      if (!parsed.ok) return false;
      return evaluateWhen(parsed.value, whenContext);
    });
  }, [contributions, whenContext]);
}
