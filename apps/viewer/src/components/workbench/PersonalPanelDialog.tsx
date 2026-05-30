/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useState } from 'react';
import type { JsonValue, WorkbenchZoneId } from '@ifc-lite/extensions';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useViewerStore } from '@/store';

type PanelTemplate = 'markdown' | 'command-stack' | 'dashboard' | 'selection-helper';

interface PersonalPanelDialogProps {
  open: boolean;
  onClose: () => void;
}

export function PersonalPanelDialog({ open, onClose }: PersonalPanelDialogProps) {
  const addPanel = useViewerStore((s) => s.addWorkbenchPersonalPanel);
  const [title, setTitle] = useState('My panel');
  const [zone, setZone] = useState<WorkbenchZoneId>('right');
  const [template, setTemplate] = useState<PanelTemplate>('markdown');
  const [markdown, setMarkdown] = useState('### Personal panel\n\nAdd notes, prompts, and command buttons here.');

  const handleCreate = () => {
    const now = new Date().toISOString();
    const id = `user:panel:${crypto.randomUUID()}`;
    addPanel({
      id,
      title: title.trim() || 'My panel',
      widget: createWidget(template, markdown),
      createdAt: now,
      updatedAt: now,
    }, zone);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add personal panel</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="personal-panel-title">Title</Label>
            <Input id="personal-panel-title" value={title} onChange={(event) => setTitle(event.currentTarget.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="personal-panel-zone">Dock target</Label>
            <select
              id="personal-panel-zone"
              value={zone}
              onChange={(event) => setZone(event.currentTarget.value as WorkbenchZoneId)}
              className="w-full rounded border bg-background px-2 py-1.5 text-sm"
            >
              <option value="left">Left</option>
              <option value="right">Right</option>
              <option value="bottom">Bottom</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="personal-panel-template">Template</Label>
            <select
              id="personal-panel-template"
              value={template}
              onChange={(event) => setTemplate(event.currentTarget.value as PanelTemplate)}
              className="w-full rounded border bg-background px-2 py-1.5 text-sm"
            >
              <option value="markdown">Markdown notes</option>
              <option value="command-stack">Command stack</option>
              <option value="dashboard">Dashboard scaffold</option>
              <option value="selection-helper">Selection helper</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="personal-panel-markdown">Markdown content</Label>
            <textarea
              id="personal-panel-markdown"
              value={markdown}
              onChange={(event) => setMarkdown(event.currentTarget.value)}
              rows={8}
              className="w-full rounded border bg-background px-2 py-1.5 text-sm font-mono"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
            <Button type="button" size="sm" onClick={handleCreate}>Create panel</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function createWidget(template: PanelTemplate, markdown: string): JsonValue {
  if (template === 'command-stack') {
    const children: JsonValue[] = [
      { type: 'Text', variant: 'heading', text: 'Command stack' },
      { type: 'Markdown', content: markdown },
      { type: 'Text', tone: 'muted', text: 'Add extension-backed command buttons here as the command registry expands.' },
    ];
    return {
      type: 'Stack',
      direction: 'vertical',
      gap: 'sm',
      children,
    };
  }
  if (template === 'dashboard') {
    const children: JsonValue[] = [
      { type: 'Text', variant: 'heading', text: 'Dashboard' },
      { type: 'KeyValueGrid', rows: [{ label: 'Status', value: 'Ready' }, { label: 'Source', value: 'Personal flavor' }] },
      { type: 'Markdown', content: markdown },
    ];
    return {
      type: 'Stack',
      direction: 'vertical',
      gap: 'md',
      children,
    };
  }
  if (template === 'selection-helper') {
    const children: JsonValue[] = [
      { type: 'Text', variant: 'heading', text: 'Selection helper' },
      { type: 'Text', tone: 'muted', text: 'Use this panel for entity review prompts and shortcuts.' },
      { type: 'Markdown', content: markdown },
    ];
    return {
      type: 'Stack',
      direction: 'vertical',
      gap: 'sm',
      children,
    };
  }
  return { type: 'Markdown', content: markdown };
}
