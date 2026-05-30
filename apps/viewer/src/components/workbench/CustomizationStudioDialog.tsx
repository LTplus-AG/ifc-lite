/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Clock, GitMerge, LayoutDashboard, PanelsTopLeft, Settings2, Wand2, Workflow } from 'lucide-react';
import { listCustomizationTemplates, simulateWorkbenchPatch } from '@ifc-lite/customization';
import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useViewerStore } from '@/store';
import { previewWorkbenchPatch } from './WorkbenchPatchDialog';
import { WidgetBuilderPanel } from './WidgetBuilderPanel';
import { EditableZonesPanel } from './EditableZonesPanel';
import { AiCustomizationPanel } from './AiCustomizationPanel';
import { WorkbenchMergePreviewPanel } from './WorkbenchMergePreviewPanel';

type StudioTab = 'templates' | 'builder' | 'zones' | 'automations' | 'history' | 'merge' | 'ai';

interface CustomizationStudioDialogProps {
  open: boolean;
  onClose: () => void;
}

export function CustomizationStudioDialog({ open, onClose }: CustomizationStudioDialogProps) {
  const layout = useViewerStore((s) => s.workbenchLayout);
  const templates = listCustomizationTemplates();
  const [tab, setTab] = useState<StudioTab>('templates');

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wand2 className="h-4 w-4" />
            Customization Studio
          </DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 md:grid-cols-[180px,1fr]">
          <aside className="space-y-1 rounded border bg-muted/20 p-2 text-sm">
            <StudioNav tab={tab} value="templates" icon={<LayoutDashboard className="h-3.5 w-3.5" />} onSelect={setTab}>Templates</StudioNav>
            <StudioNav tab={tab} value="builder" icon={<PanelsTopLeft className="h-3.5 w-3.5" />} onSelect={setTab}>Widget builder</StudioNav>
            <StudioNav tab={tab} value="zones" icon={<Settings2 className="h-3.5 w-3.5" />} onSelect={setTab}>Built-ins</StudioNav>
            <StudioNav tab={tab} value="automations" icon={<Workflow className="h-3.5 w-3.5" />} onSelect={setTab}>Automations</StudioNav>
            <StudioNav tab={tab} value="history" icon={<Clock className="h-3.5 w-3.5" />} onSelect={setTab}>History</StudioNav>
            <StudioNav tab={tab} value="merge" icon={<GitMerge className="h-3.5 w-3.5" />} onSelect={setTab}>Merge</StudioNav>
            <StudioNav tab={tab} value="ai" icon={<Wand2 className="h-3.5 w-3.5" />} onSelect={setTab}>AI plans</StudioNav>
          </aside>
          <ScrollArea className="max-h-[62vh] pr-3">
            {tab === 'templates' && <div className="space-y-3">
              {templates.map((template) => {
                const patch = template.plan.patch;
                const simulation = patch ? simulateWorkbenchPatch(layout, patch) : undefined;
                return (
                  <div key={template.id} className="rounded border bg-background p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2 font-medium">
                          <LayoutDashboard className="h-4 w-4 text-primary" />
                          {template.name}
                        </div>
                        <p className="mt-1 text-sm text-muted-foreground">{template.description}</p>
                        <div className="mt-2 text-xs text-muted-foreground">
                          {simulation?.changes.length ?? 0} operation{simulation?.changes.length === 1 ? '' : 's'}
                          {simulation && simulation.warnings.length > 0 ? ` · ${simulation.warnings.length} warning(s)` : ''}
                        </div>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        disabled={!patch}
                        onClick={() => {
                          if (patch) previewWorkbenchPatch(patch);
                          onClose();
                        }}
                      >
                        Preview
                      </Button>
                    </div>
                    {simulation && (
                      <div className="mt-3 rounded bg-muted/30 p-2">
                        {simulation.changes.slice(0, 4).map((change, index) => (
                          <div key={`${change.operation}-${index}`} className="text-xs">
                            <span className="font-medium">{change.label}</span>
                            {change.detail ? <span className="text-muted-foreground"> — {change.detail}</span> : null}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>}
            {tab === 'builder' && <WidgetBuilderPanel />}
            {tab === 'zones' && <EditableZonesPanel />}
            {tab === 'automations' && <AutomationRunLogPanel />}
            {tab === 'history' && <HistoryPanel />}
            {tab === 'merge' && <WorkbenchMergePreviewPanel />}
            {tab === 'ai' && <AiCustomizationPanel onPreview={onClose} />}
          </ScrollArea>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function StudioNav({
  tab,
  value,
  icon,
  children,
  onSelect,
}: {
  tab: StudioTab;
  value: StudioTab;
  icon: ReactNode;
  children: ReactNode;
  onSelect: (tab: StudioTab) => void;
}) {
  return (
    <button
      type="button"
      className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left ${tab === value ? 'bg-background font-medium' : 'text-muted-foreground hover:bg-background/60'}`}
      onClick={() => onSelect(value)}
    >
      {icon}
      {children}
    </button>
  );
}

function AutomationRunLogPanel() {
  const runs = useViewerStore((s) => s.workbenchLayout.automationRuns);
  return (
    <div className="space-y-2">
      {runs.slice().reverse().map((run) => (
        <div key={run.id} className="rounded border p-3 text-sm">
          <div className="font-medium">{run.automationName}</div>
          <div className="text-xs text-muted-foreground">{run.status} · {run.trigger} · {run.createdAt}</div>
          {run.message && <div className="mt-1 text-xs">{run.message}</div>}
        </div>
      ))}
      {runs.length === 0 && <div className="rounded border border-dashed p-4 text-sm text-muted-foreground">No automation runs yet.</div>}
    </div>
  );
}

function HistoryPanel() {
  const history = useViewerStore((s) => s.workbenchLayout.history);
  return (
    <div className="space-y-2">
      {history.slice().reverse().map((entry) => (
        <div key={entry.id} className="rounded border p-3 text-sm">
          <div className="font-medium">{entry.label}</div>
          <div className="text-xs text-muted-foreground">{entry.createdAt}{entry.patchId ? ` · ${entry.patchId}` : ''}</div>
        </div>
      ))}
      {history.length === 0 && <div className="rounded border border-dashed p-4 text-sm text-muted-foreground">No workbench history yet.</div>}
    </div>
  );
}
