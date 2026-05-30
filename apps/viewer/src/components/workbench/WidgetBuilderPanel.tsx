/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo, useState } from 'react';
import { validateWidget, type JsonValue } from '@ifc-lite/extensions';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useViewerStore } from '@/store';
import { WidgetRenderer, type WidgetRendererContext } from '@/components/extensions/widget/WidgetRenderer';
import { useOptionalExtensionHost } from '@/sdk/ExtensionHostProvider';

const BLOCKS: Array<{ label: string; node: JsonValue }> = [
  { label: 'Heading', node: { type: 'Text', variant: 'heading', text: 'New heading' } },
  { label: 'Markdown', node: { type: 'Markdown', content: 'Write notes here.' } },
  { label: 'Key/value grid', node: { type: 'KeyValueGrid', rows: [{ label: 'Status', value: 'Draft' }] } },
  { label: 'Button placeholder', node: { type: 'Text', tone: 'muted', text: 'Button placeholder: bind to an extension command.' } },
];

export function WidgetBuilderPanel() {
  const addPanel = useViewerStore((s) => s.addWorkbenchPersonalPanel);
  const [title, setTitle] = useState('Visual panel');
  const [children, setChildren] = useState<JsonValue[]>([
    { type: 'Text', variant: 'heading', text: 'Visual panel' },
    { type: 'Markdown', content: 'Use the block palette to compose this panel.' },
  ]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const widget = useMemo<JsonValue>(() => ({ type: 'Stack', direction: 'vertical', gap: 'md', children }), [children]);
  const validated = useMemo(() => validateWidget(widget, 'widget-builder'), [widget]);
  const ctx = useWidgetContext();

  const updateSelected = (raw: string) => {
    try {
      const parsed = JSON.parse(raw) as JsonValue;
      setChildren((items) => items.map((item, index) => index === selectedIndex ? parsed : item));
    } catch {
      // Keep editing local text tolerant; validation catches once valid JSON is entered.
    }
  };

  return (
    <div className="grid gap-3 md:grid-cols-[150px,1fr,260px]">
      <div className="space-y-2 rounded border p-2">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Blocks</div>
        {BLOCKS.map((block) => (
          <Button key={block.label} type="button" size="sm" variant="secondary" className="w-full justify-start" onClick={() => setChildren((items) => [...items, block.node])}>
            {block.label}
          </Button>
        ))}
      </div>
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <input value={title} onChange={(event) => setTitle(event.currentTarget.value)} className="rounded border bg-background px-2 py-1 text-sm" />
          <Button
            type="button"
            size="sm"
            disabled={!validated.ok}
            onClick={() => {
              const now = new Date().toISOString();
              addPanel({
                id: `user:panel:${crypto.randomUUID()}`,
                title,
                widget,
                createdAt: now,
                updatedAt: now,
              }, 'right');
            }}
          >
            Save panel
          </Button>
        </div>
        <ScrollArea className="h-[380px] rounded border bg-background">
          <div className="p-3">
            {validated.ok ? (
              <WidgetRenderer node={validated.value} ctx={ctx} />
            ) : (
              <div className="text-xs text-destructive">{validated.errors[0]?.message ?? 'Widget invalid'}</div>
            )}
          </div>
        </ScrollArea>
      </div>
      <div className="space-y-2 rounded border p-2">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Layers</div>
        <div className="space-y-1">
          {children.map((child, index) => (
            <button
              key={index}
              type="button"
              className={`w-full rounded px-2 py-1 text-left text-xs ${selectedIndex === index ? 'bg-primary/10 text-primary' : 'hover:bg-muted'}`}
              onClick={() => setSelectedIndex(index)}
            >
              {typeof child === 'object' && child && !Array.isArray(child) && typeof child.type === 'string' ? child.type : `Node ${index + 1}`}
            </button>
          ))}
        </div>
        <Label htmlFor="selected-node-json">Selected node JSON</Label>
        <textarea
          id="selected-node-json"
          value={JSON.stringify(children[selectedIndex] ?? {}, null, 2)}
          onChange={(event) => updateSelected(event.currentTarget.value)}
          rows={12}
          className="w-full rounded border bg-background px-2 py-1 text-xs font-mono"
        />
      </div>
    </div>
  );
}

function useWidgetContext(): WidgetRendererContext {
  const host = useOptionalExtensionHost();
  return useMemo(() => ({
    state: {},
    invokeCommand: (commandId: string) => {
      host?.runCommand(commandId).catch((err) => {
        console.warn('[WidgetBuilderPanel] command failed:', err);
      });
    },
  }), [host]);
}
