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
import { parseWhen, evaluateWhen, type DockContribution, type SlotContribution } from '@ifc-lite/extensions';
import { useSlotContributions } from '@/hooks/useSlotContributions';
import { useExtensionHost } from '@/sdk/ExtensionHostProvider';
import { WidgetRenderer, type WidgetRendererContext } from './widget/WidgetRenderer';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

interface ExtensionDockHostProps {
  slot: DockContribution['slot'];
  /** Tailwind class to apply to the container. */
  className?: string;
}

export function ExtensionDockHost({ slot, className }: ExtensionDockHostProps) {
  const contributions = useSlotContributions<DockContribution>(slot);
  const visible = useFiltered(contributions);
  const [activeId, setActiveId] = useState<string | undefined>(visible[0]?.payload.id);

  useEffect(() => {
    if (!visible.find((v) => v.payload.id === activeId)) {
      setActiveId(visible[0]?.payload.id);
    }
  }, [visible, activeId]);

  if (visible.length === 0) return null;

  const active = visible.find((v) => v.payload.id === activeId) ?? visible[0];

  return (
    <div className={cn('flex flex-col h-full border-t bg-background', className)}>
      <div className="flex items-center gap-0 border-b overflow-x-auto">
        {visible.map((c) => {
          const isActive = c.payload.id === active.payload.id;
          return (
            <button
              key={`${c.extensionId}:${c.payload.id}`}
              type="button"
              onClick={() => setActiveId(c.payload.id)}
              className={cn(
                'shrink-0 px-3 py-1.5 text-xs font-medium border-b-2 transition-colors',
                isActive
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
              title={`${c.payload.title} — ${c.extensionId}`}
            >
              {c.payload.title}
            </button>
          );
        })}
      </div>
      <ScrollArea className="flex-1">
        <DockBody contribution={active} />
      </ScrollArea>
    </div>
  );
}

function useFiltered(contributions: SlotContribution<DockContribution>[]): SlotContribution<DockContribution>[] {
  return useMemo(() => {
    return contributions.filter((c) => {
      if (!c.payload.when) return true;
      const parsed = parseWhen(c.payload.when);
      if (!parsed.ok) return false;
      // Minimal context — dock visibility commonly keys on model.loaded.
      // Future: surface a richer context here as the viewer fills out
      // more of the WhenContext vocabulary.
      return evaluateWhen(parsed.value, { 'model.loaded': true });
    });
  }, [contributions]);
}

function DockBody({ contribution }: { contribution: SlotContribution<DockContribution> }) {
  const host = useExtensionHost();
  const [widget, setWidget] = useState<unknown>();
  const [error, setError] = useState<string | undefined>();
  const ctx: WidgetRendererContext = useMemo(
    () => ({
      state: {},
      invokeCommand: (commandId: string) => {
        host.runCommand(commandId).catch((err) => {
          console.warn('[ExtensionDockHost] command failed:', err);
        });
      },
    }),
    [host],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const bundle = host.loader.getBundle(contribution.extensionId);
        if (!bundle) {
          if (!cancelled) setError(`Bundle for ${contribution.extensionId} not loaded.`);
          return;
        }
        const file = bundle.files.get(contribution.payload.widget);
        if (!file) {
          if (!cancelled) setError(`Widget "${contribution.payload.widget}" not found in bundle.`);
          return;
        }
        const text = file.text ?? new TextDecoder().decode(file.bytes);
        const json = JSON.parse(text);
        if (!cancelled) setWidget(json);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [host, contribution]);

  if (error) {
    return (
      <div className="p-3 text-xs text-rose-600 dark:text-rose-400">
        {error}
      </div>
    );
  }
  if (!widget) {
    return <div className="p-3 text-xs text-muted-foreground">Loading widget…</div>;
  }
  return (
    <div className="p-3">
      <WidgetRenderer
        node={widget as Parameters<typeof WidgetRenderer>[0]['node']}
        ctx={ctx}
      />
    </div>
  );
}
