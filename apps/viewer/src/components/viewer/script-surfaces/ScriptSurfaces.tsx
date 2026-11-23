/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Surfaces a script presented with `bim.ui.*`, rendered live through the shared
 * A2UI seam. Follow-up buttons continue in the chat. The raw payload stays one
 * click away for script authors.
 */

import { memo, useState } from 'react';
import type { CreateSurfaceMessage } from '@ifc-lite/a2ui';
import { useTranslation } from '@/i18n';
import { followUpToChat } from '@/lib/a2ui/actions';
import { A2uiMessagesView, type AgentToRendererMessage } from '@/lib/a2ui/surface-host';

interface ScriptSurfacesProps {
  surfaces: CreateSurfaceMessage[][];
}

export const ScriptSurfaces = memo(function ScriptSurfaces({ surfaces }: ScriptSurfacesProps) {
  const { t } = useTranslation();
  if (!surfaces.length) return null;
  return (
    <div className="mt-1 flex flex-col gap-2 border-t border-border/50 pt-2" data-script-surfaces={surfaces.length}>
      {surfaces.map((batch, index) => (
        <A2uiMessagesView
          key={batch[0]?.createSurface.surfaceId ?? index}
          messages={batch as unknown as AgentToRendererMessage[]}
          onFollowUp={followUpToChat}
        />
      ))}
      <RawPayload surfaces={surfaces} label={t('scriptPanel.output.surfaces', { count: surfaces.length })} />
    </div>
  );
});

/** The raw payload, serialised only once the author opens it. */
function RawPayload({ surfaces, label }: { surfaces: CreateSurfaceMessage[][]; label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="text-muted-foreground" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer">{label}</summary>
      {open && <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(surfaces, null, 2)}</pre>}
    </details>
  );
}
