/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState } from 'react';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { usePanelControls } from '@/hooks/usePanelControls';
import { readStartupFlowId, resolveStartupFlow, saveStartupFlowId, suppressStartupWorkflow } from '@/lib/flow/startup-preference';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

let offeredThisSession = false;

/** Opt-in prompt opens configuration; Run remains an explicit user action in Player. */
export function FlowStartupPrompt() {
  const { t } = useTranslation();
  const panels = usePanelControls();
  const [flowId, setFlowId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const savedFlows = useViewerStore((s) => s.savedFlows);
  const selected = resolveStartupFlow(savedFlows, flowId);
  useEffect(() => {
    if (offeredThisSession || suppressStartupWorkflow(window.location.search)) return;
    const id = readStartupFlowId();
    if (!id) return;
    if (!resolveStartupFlow(useViewerStore.getState().savedFlows, id)) {
      try { saveStartupFlowId(null); } catch (cause) { console.warn('[flow] could not clear missing startup graph', cause); }
      return;
    }
    // Startup dialogs and tours own the modal layer first. Recheck rather than stack prompts.
    const timer = window.setInterval(() => {
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      if (useViewerStore.getState().flowRunning || useViewerStore.getState().flowDoc) {
        window.clearInterval(timer);
        return;
      }
      if (offeredThisSession) { window.clearInterval(timer); return; }
      offeredThisSession = true;
      setFlowId(id);
      window.clearInterval(timer);
    }, 500);
    return () => window.clearInterval(timer);
  }, []);
  if (!selected) return null;
  const dismiss = () => setFlowId(null);
  return <Dialog open onOpenChange={(open) => { if (!open) dismiss(); }}>
    <DialogContent>
      <DialogHeader><DialogTitle>{t('flowStartup.title')}</DialogTitle>
        <DialogDescription>{t('flowStartup.description', { name: selected.doc.name })}</DialogDescription>
      </DialogHeader>
      {error && <output className="text-sm text-destructive">{error}</output>}
      <DialogFooter>
        <Button variant="outline" onClick={() => {
          try { saveStartupFlowId(null); dismiss(); }
          catch (cause) { setError(t('flowStartup.storageError', { reason: cause instanceof Error ? cause.message : String(cause) })); }
        }}>{t('flowStartup.disable')}</Button>
        <Button variant="outline" onClick={dismiss}>{t('flowStartup.skip')}</Button>
        <Button onClick={() => {
          const state = useViewerStore.getState();
          if (!resolveStartupFlow(state.savedFlows, selected.doc.id)) { dismiss(); return; }
          state.setFlowView('player');
          state.openFlow(selected.doc.id);
          panels.openInHome('flow');
          dismiss();
        }}>{t('flowStartup.open')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
