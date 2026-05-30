/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useState } from 'react';
import { Play, Save, Trash2, Zap } from 'lucide-react';
import type { UiAutomationTrigger, WorkbenchZoneId } from '@ifc-lite/extensions';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useViewerStore } from '@/store';
import { listWorkbenchPanels, ZONE_LABEL } from './panelRegistry';

interface WorkspaceModesDialogProps {
  open: boolean;
  onClose: () => void;
}

export function WorkspaceModesDialog({ open, onClose }: WorkspaceModesDialogProps) {
  const layout = useViewerStore((s) => s.workbenchLayout);
  const saveMode = useViewerStore((s) => s.saveWorkbenchMode);
  const applyMode = useViewerStore((s) => s.applyWorkbenchMode);
  const deleteMode = useViewerStore((s) => s.deleteWorkbenchMode);
  const upsertAutomation = useViewerStore((s) => s.upsertWorkbenchAutomation);
  const deleteAutomation = useViewerStore((s) => s.deleteWorkbenchAutomation);
  const [modeName, setModeName] = useState('Review workspace');
  const [automationName, setAutomationName] = useState('Open Properties on selection');
  const [trigger, setTrigger] = useState<UiAutomationTrigger['kind']>('selection.changed');
  const [panelId, setPanelId] = useState('builtin:panel:properties');
  const [zone, setZone] = useState<WorkbenchZoneId>('right');
  const panels = listWorkbenchPanels(layout);

  const handleSaveMode = () => {
    saveMode(modeName.trim() || 'Workspace mode');
  };

  const handleAddAutomation = () => {
    upsertAutomation({
      id: `automation:${crypto.randomUUID()}`,
      name: automationName.trim() || 'Workbench automation',
      enabled: true,
      trigger: trigger === 'panel.opened' ? { kind: trigger, panelId } : { kind: trigger },
      actions: [
        { kind: 'layout.movePanel', panelId, zone },
        { kind: 'layout.openPanel', panelId },
      ],
    });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Workspace modes & automations</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 md:grid-cols-2">
          <section className="space-y-3">
            <div className="rounded border p-3">
              <Label htmlFor="workspace-mode-name">Save current layout as mode</Label>
              <div className="mt-2 flex gap-2">
                <Input id="workspace-mode-name" value={modeName} onChange={(event) => setModeName(event.currentTarget.value)} />
                <Button type="button" size="sm" onClick={handleSaveMode}>
                  <Save className="mr-1 h-3.5 w-3.5" />
                  Save
                </Button>
              </div>
            </div>
            <ScrollArea className="h-[330px] pr-3">
              <div className="space-y-2">
                {Object.values(layout.workspaceModes).map((mode) => (
                  <div key={mode.id} className="rounded border p-3">
                    <div className="font-medium text-sm">{mode.name}</div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">{mode.id}</div>
                    <div className="mt-2 flex gap-2">
                      <Button type="button" size="sm" onClick={() => applyMode(mode.id)}>
                        <Play className="mr-1 h-3.5 w-3.5" />
                        Apply
                      </Button>
                      <Button type="button" size="sm" variant="ghost" onClick={() => deleteMode(mode.id)}>
                        <Trash2 className="mr-1 h-3.5 w-3.5" />
                        Delete
                      </Button>
                    </div>
                  </div>
                ))}
                {Object.keys(layout.workspaceModes).length === 0 && (
                  <div className="rounded border border-dashed p-4 text-sm text-muted-foreground">
                    No workspace modes yet. Morph the UI, then save the current arrangement.
                  </div>
                )}
              </div>
            </ScrollArea>
          </section>

          <section className="space-y-3">
            <div className="rounded border p-3 space-y-2">
              <Label>Add behavior automation</Label>
              <Input value={automationName} onChange={(event) => setAutomationName(event.currentTarget.value)} />
              <div className="grid grid-cols-3 gap-2">
                <select value={trigger} onChange={(event) => setTrigger(event.currentTarget.value as UiAutomationTrigger['kind'])} className="rounded border bg-background px-2 py-1.5 text-sm">
                  <option value="selection.changed">Selection changes</option>
                  <option value="model.loaded">Model loads</option>
                  <option value="panel.opened">Panel opens</option>
                </select>
                <select value={panelId} onChange={(event) => setPanelId(event.currentTarget.value)} className="rounded border bg-background px-2 py-1.5 text-sm">
                  {panels.map((panel) => <option key={panel.id} value={panel.id}>{panel.title}</option>)}
                </select>
                <select value={zone} onChange={(event) => setZone(event.currentTarget.value as WorkbenchZoneId)} className="rounded border bg-background px-2 py-1.5 text-sm">
                  {(['left', 'right', 'bottom'] as const).map((z) => <option key={z} value={z}>{ZONE_LABEL[z]}</option>)}
                </select>
              </div>
              <Button type="button" size="sm" onClick={handleAddAutomation}>
                <Zap className="mr-1 h-3.5 w-3.5" />
                Add automation
              </Button>
            </div>
            <ScrollArea className="h-[245px] pr-3">
              <div className="space-y-2">
                {layout.automations.map((automation) => (
                  <div key={automation.id} className="rounded border p-3">
                    <div className="font-medium text-sm">{automation.name}</div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">
                      {automation.trigger.kind} · {automation.actions.length} action{automation.actions.length === 1 ? '' : 's'}
                    </div>
                    <Button type="button" size="sm" variant="ghost" className="mt-2" onClick={() => deleteAutomation(automation.id)}>
                      <Trash2 className="mr-1 h-3.5 w-3.5" />
                      Delete
                    </Button>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
