/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useMemo, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { validateWidget, type JsonValue, type PersonalPanelDefinition } from '@ifc-lite/extensions';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useOptionalExtensionHost } from '@/sdk/ExtensionHostProvider';
import { useViewerStore } from '@/store';
import { WidgetRenderer, type WidgetRendererContext } from '@/components/extensions/widget/WidgetRenderer';
import { getWorkbenchPanelTitle } from './panelRegistry';

interface PanelChromeDialogProps {
  panelId: string | null;
  onClose: () => void;
}

export function PanelChromeDialog({ panelId, onClose }: PanelChromeDialogProps) {
  const layout = useViewerStore((s) => s.workbenchLayout);
  const setChrome = useViewerStore((s) => s.setWorkbenchPanelChrome);
  const updatePersonal = useViewerStore((s) => s.updateWorkbenchPersonalPanel);
  const removePersonal = useViewerStore((s) => s.removeWorkbenchPersonalPanel);
  const panel = panelId ? layout.personalPanels[panelId] : undefined;
  const initialTitle = useMemo(() => panelId ? getWorkbenchPanelTitle(layout, panelId) : '', [layout, panelId]);
  const [title, setTitle] = useState(initialTitle);
  const [accent, setAccent] = useState('');
  const [widgetJson, setWidgetJson] = useState('');
  const preview = useWidgetPreview(widgetJson);
  const ctx = useWidgetContext();

  useEffect(() => {
    if (!panelId) return;
    const personal = layout.personalPanels[panelId];
    setTitle(getWorkbenchPanelTitle(layout, panelId));
    setAccent(layout.panelChrome[panelId]?.accent ?? '');
    setWidgetJson(JSON.stringify(personal?.widget ?? { type: 'Markdown', content: '' }, null, 2));
  }, [layout, panelId]);

  const handleSave = () => {
    if (!panelId) return;
    const nextTitle = title.trim() || initialTitle || panelId;
    setChrome(panelId, { title: nextTitle, accent: accent.trim() || undefined });
    if (panel) {
      if (!preview.ok) return;
      updatePersonal({
        ...panel,
        title: nextTitle,
        widget: preview.value,
        updatedAt: new Date().toISOString(),
      });
    }
    onClose();
  };

  return (
    <Dialog open={!!panelId} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Edit panel chrome</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="panel-title">Title</Label>
            <Input id="panel-title" value={title} onChange={(event) => setTitle(event.currentTarget.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="panel-accent">Accent token</Label>
            <Input
              id="panel-accent"
              value={accent}
              onChange={(event) => setAccent(event.currentTarget.value)}
              placeholder="e.g. fire, qa, review"
            />
          </div>
          {panel && (
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="panel-widget-json">Widget JSON</Label>
                <textarea
                  id="panel-widget-json"
                  value={widgetJson}
                  onChange={(event) => setWidgetJson(event.currentTarget.value)}
                  rows={16}
                  className="w-full rounded border bg-background px-2 py-1.5 text-xs font-mono"
                />
                {!preview.ok && (
                  <div className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive">
                    {preview.error}
                  </div>
                )}
              </div>
              <div className="space-y-1.5">
                <Label>Live preview</Label>
                <ScrollArea className="h-[360px] rounded border bg-background">
                  <div className="p-3">
                    {preview.ok ? (
                      <WidgetRenderer node={preview.node} ctx={ctx} />
                    ) : (
                      <div className="text-xs text-muted-foreground">Fix JSON/validation errors to preview this panel.</div>
                    )}
                  </div>
                </ScrollArea>
              </div>
            </div>
          )}
          <div className="flex items-center justify-between gap-2">
            {panel ? (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={() => {
                  removePersonal(panel.id);
                  onClose();
                }}
              >
                <Trash2 className="mr-1 h-3.5 w-3.5" />
                Delete panel
              </Button>
            ) : <span />}
            <div className="flex gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
              <Button type="button" size="sm" onClick={handleSave} disabled={panel ? !preview.ok : false}>Save</Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

type WidgetPreview =
  | { ok: true; value: JsonValue; node: Parameters<typeof WidgetRenderer>[0]['node'] }
  | { ok: false; error: string };

function useWidgetPreview(widgetJson: string): WidgetPreview {
  return useMemo(() => {
    try {
      const parsed = JSON.parse(widgetJson) as unknown;
      const validated = validateWidget(parsed, 'personal-panel.widget');
      if (!validated.ok) {
        const first = validated.errors[0];
        return { ok: false, error: `${first?.path ?? 'widget'} ${first?.message ?? 'failed validation'}` };
      }
      return {
        ok: true,
        value: validated.value as unknown as JsonValue,
        node: validated.value,
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }, [widgetJson]);
}

function useWidgetContext(): WidgetRendererContext {
  const host = useOptionalExtensionHost();
  return useMemo(() => ({
    state: {},
    invokeCommand: (commandId: string) => {
      host?.runCommand(commandId).catch((err) => {
        console.warn('[PanelChromeDialog] widget command failed:', err);
      });
    },
  }), [host]);
}
