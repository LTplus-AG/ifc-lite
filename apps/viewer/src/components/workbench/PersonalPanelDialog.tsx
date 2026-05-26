/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useState } from 'react';
import type { WorkbenchZoneId } from '@ifc-lite/extensions';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useViewerStore } from '@/store';

interface PersonalPanelDialogProps {
  open: boolean;
  onClose: () => void;
}

export function PersonalPanelDialog({ open, onClose }: PersonalPanelDialogProps) {
  const addPanel = useViewerStore((s) => s.addWorkbenchPersonalPanel);
  const [title, setTitle] = useState('My panel');
  const [zone, setZone] = useState<WorkbenchZoneId>('right');
  const [markdown, setMarkdown] = useState('### Personal panel\n\nAdd notes, prompts, and command buttons here.');

  const handleCreate = () => {
    const now = new Date().toISOString();
    const id = `user:panel:${crypto.randomUUID()}`;
    addPanel({
      id,
      title: title.trim() || 'My panel',
      widget: {
        type: 'Markdown',
        content: markdown,
      },
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
