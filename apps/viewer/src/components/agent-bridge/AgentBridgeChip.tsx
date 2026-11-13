/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The status-bar chip of a local agent connection (#9523, desktop layout):
 * "Local agent connected · read-only" while paired, opening the connection
 * panel (Disconnect, activity log); after a drop it says why. Loaded with
 * `import()` only once a connection exists.
 */

import { useState } from 'react';
import { Bot } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';
import { useAgentBridgeState } from '@/lib/agent-bridge/state';
import { AgentBridgeConnectionPanel, useAgentBridgeLabel } from './AgentBridgeConnectionPanel';

export function AgentBridgeChip() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { status } = useAgentBridgeState();
  const label = useAgentBridgeLabel();
  const connected = status.kind === 'connected';
  return (<>
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" title={t('agentBridge.chip.title')} data-agent-bridge-chip={status.kind}
          className={cn(
            // Status-bar text metrics, with the same hit-slop idiom as its other chips (#5826).
            'relative h-auto gap-1.5 rounded px-1 -mx-1 py-0 text-xs font-normal after:absolute after:inset-x-0 after:-top-1 after:-bottom-1 after:content-[\'\']',
            connected ? 'text-foreground' : status.kind === 'disconnected' && 'text-destructive',
          )}>
          <Bot className={cn('h-3.5 w-3.5', connected && 'text-status-ok')} aria-hidden />
          <span>{label}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="w-96 p-3">
        <AgentBridgeConnectionPanel onDone={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
    {/* Trailing separator, as the workspace chip beside it does. */}
    <Separator orientation="vertical" className="h-3.5" />
  </>);
}
