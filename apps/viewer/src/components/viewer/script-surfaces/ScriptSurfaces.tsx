/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Surfaces a script presented with `bim.ui.*`, rendered live through the shared
 * A2UI seam. Follow-up buttons continue in the chat. The raw payload stays one
 * click away for script authors.
 */

import { useCallback } from 'react';
import type { CreateSurfaceMessage } from '@ifc-lite/a2ui';
import { useTranslation } from '@/i18n';
import { composeFollowUpPrompt } from '@/lib/a2ui/actions';
import { A2uiMessagesView, type AgentToRendererMessage } from '@/lib/a2ui/surface-host';
import { useViewerStore } from '@/store';

interface ScriptSurfacesProps {
  surfaces: CreateSurfaceMessage[][];
  onFollowUp?: (text: string, context: Record<string, unknown>) => void;
}

export function ScriptSurfaces({ surfaces, onFollowUp }: ScriptSurfacesProps) {
  const { t } = useTranslation();
  const toChat = useCallback((text: string, context: Record<string, unknown>) => {
    useViewerStore.getState().queueChatPrompt(composeFollowUpPrompt(text, context));
  }, []);
  if (!surfaces.length) return null;
  return (
    <div className="mt-1 flex flex-col gap-2 border-t border-border/50 pt-2" data-script-surfaces={surfaces.length}>
      {surfaces.map((batch, index) => (
        <A2uiMessagesView
          key={batch[0]?.createSurface.surfaceId ?? index}
          messages={batch as unknown as AgentToRendererMessage[]}
          onFollowUp={onFollowUp ?? toChat}
        />
      ))}
      <details className="text-muted-foreground">
        <summary className="cursor-pointer">{t('scriptPanel.output.surfaces', { count: surfaces.length })}</summary>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(surfaces, null, 2)}</pre>
      </details>
    </div>
  );
}
