/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The phone layout's local-agent indicator (#9523). Phones have no status
 * bar, so a live (or just ended) connection gets a persistent 44px pill in
 * the viewport's top-left corner, styled as the Panels launcher, which opens
 * the connection panel in a dialog, as the activity tray does on phones.
 */

import { useState } from 'react';
import { Bot } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { mobileCommandPlacement } from '@/lib/layout/form-factor';
import { MOBILE_NAV_ROW } from '@/components/viewer/mobile-overlay-layout';
import { useAgentBridgeState } from '@/lib/agent-bridge/state';
import { AgentBridgeConnectionPanel, useAgentBridgeLabel } from './AgentBridgeConnectionPanel';

export function AgentBridgeMobileIndicator() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { status } = useAgentBridgeState();
  const placement = useViewerStore((s) => mobileCommandPlacement(s.formFactor));
  const label = useAgentBridgeLabel();
  return (
    <>
      <Button variant="outline" data-agent-bridge-mobile={status.kind} onClick={() => setOpen(true)}
        className={cn('fixed z-20 h-11 gap-2 bg-background/90 pl-3 pr-4 shadow-sm backdrop-blur-sm touch-manipulation',
          status.kind === 'disconnected' && 'text-destructive')}
        style={{ top: 'max(1rem, env(safe-area-inset-top))', left: MOBILE_NAV_ROW[placement].left }}>
        <Bot className={cn('h-4 w-4', status.kind === 'connected' && 'text-status-ok')} aria-hidden />
        {label}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent aria-describedby={undefined} className="max-w-sm">
          <DialogTitle className="text-sm">{t('agentBridge.chip.title')}</DialogTitle>
          <AgentBridgeConnectionPanel onDone={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}
