/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Surfaces an external agent pushed with `viewer_show_ui`, stacked newest
 * first over the viewport. Loaded only once a surface arrives. Follow-up
 * buttons go back to that agent as UI events (`viewer_ui_events`, or a Claude
 * Code channel message); with a bridge that predates them they continue in
 * the in-app chat.
 */

import { useSyncExternalStore } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { useTranslation } from '@/i18n';
import { followUpToChat } from '@/lib/a2ui/actions';
import { A2uiMessagesView, type AgentToRendererMessage } from '@/lib/a2ui/surface-host';
import { agentSurfaces, type AgentSurface } from '@/lib/agent-bridge/agent-surfaces';
import { sendAgentUiEvent } from '@/lib/agent-bridge/session';
import { toast } from '@/components/ui/toast';

const MAX_VISIBLE = 3;
const keys = new WeakMap<object, number>();
let nextKey = 0;
function keyOf(surface: object): number {
  let key = keys.get(surface);
  if (key === undefined) keys.set(surface, key = ++nextKey);
  return key;
}

function surfaceIdOf(surface: AgentSurface): string {
  for (const message of surface.messages) {
    const id = (message as { createSurface?: { surfaceId?: unknown } }).createSurface?.surfaceId;
    if (typeof id === 'string' && id) return id;
  }
  return 'agent-surface';
}

export function AgentSurfacesDock() {
  const { t } = useTranslation();
  const surfaces = useSyncExternalStore(agentSurfaces.subscribe, agentSurfaces.getSnapshot);
  const followUp = (surface: AgentSurface) => (text: string, context: Record<string, unknown>) => {
    if (sendAgentUiEvent({ surfaceId: surfaceIdOf(surface), name: 'ask', prompt: text, context })) {
      toast.success(t('agentBridge.surfaces.sent'));
      return;
    }
    followUpToChat(text, context);
  };
  if (surfaces.length === 0) return null;
  const visible = surfaces.slice(-MAX_VISIBLE).reverse();
  return (
    <aside
      aria-label={t('agentBridge.surfaces.title')}
      data-agent-surfaces={surfaces.length}
      className="pointer-events-none fixed bottom-3 right-3 top-14 z-30 flex w-96 max-w-full flex-col gap-2 overflow-y-auto"
    >
      <div className="pointer-events-auto flex items-center justify-between rounded-md bg-background/90 px-2 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur">
        <span>{t('agentBridge.surfaces.title')}</span>
        {surfaces.length > 1 && (
          <Button size="sm" variant="ghost" onClick={() => agentSurfaces.clear()}>{t('agentBridge.surfaces.clear')}</Button>
        )}
      </div>
      {visible.map((surface) => {
        const title = surface.title ?? t('agentBridge.surfaces.untitled');
        return (
          <section key={keyOf(surface)} className="pointer-events-auto rounded-lg border bg-background/95 p-3 shadow-md backdrop-blur">
            <header className="mb-2 flex items-center justify-between gap-2">
              <h2 className="truncate text-sm font-semibold">{title}</h2>
              <IconButton className="h-6 w-6" label={t('agentBridge.surfaces.dismiss', { title })} onClick={() => agentSurfaces.dismiss(surface)}>
                <X className="h-3.5 w-3.5" />
              </IconButton>
            </header>
            <A2uiMessagesView messages={surface.messages as AgentToRendererMessage[]} onFollowUp={followUp(surface)} />
          </section>
        );
      })}
    </aside>
  );
}
