/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Renders a session's segments in order: prose through the caller's text
 * renderer (the chat keeps its executable code blocks), surfaces through
 * `SurfaceView`, and rejected blocks as a compact notice with a repair button.
 */

import { useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { BimReactContext } from '@/sdk/BimProvider';
import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { createBimViewerHost, type A2uiViewerHost } from '@/lib/a2ui/host';
import type { FollowUpHandler } from '@/lib/a2ui/actions';
import type { A2uiMessageSession } from '@/lib/a2ui/session';
import { A2uiRuntimeContext, type A2uiRuntime } from './runtime';
import { Note } from './notes';
import { SurfaceView } from './SurfaceView';

/** The viewer host over the app's `BimContext`, or null outside a `BimProvider`. */
export function useViewerHost(): A2uiViewerHost | null {
  const bim = useContext(BimReactContext);
  return useMemo(() => (bim ? createBimViewerHost(bim) : null), [bim]);
}

/** Model-facing repair prompt for a rejected block. Sent to the assistant, so it stays English. */
function repairPrompt(error: string): string {
  return `Your last <a2ui> block was rejected by the viewer: ${error}\nSend the corrected <a2ui> block only.`;
}

interface SegmentsViewProps {
  session: A2uiMessageSession;
  host: A2uiViewerHost;
  onFollowUp?: FollowUpHandler;
  /** Render one prose segment; `codeStart` is the index of its first code block in the whole message. */
  renderText: (text: string, codeStart: number, key: string) => { node: ReactNode; codeCount: number };
}

export function SegmentsView({ session, host, onFollowUp, renderText }: SegmentsViewProps) {
  const { t } = useTranslation();
  useSyncExternalStore(session.subscribe, session.getVersion, session.getVersion);
  session.onFollowUp = onFollowUp;
  const runtime: A2uiRuntime = useMemo(() => ({ host, onFollowUp }), [host, onFollowUp]);
  let codeStart = 0;
  return (
    <A2uiRuntimeContext.Provider value={runtime}>
      {session.segments.map((segment, i) => {
        if (segment.kind === 'text') {
          const { node, codeCount } = renderText(segment.text, codeStart, `t${i}`);
          codeStart += codeCount;
          return node;
        }
        if (segment.kind === 'error') {
          return (
            <div key={`e${i}`} className="my-2">
              <Note tone="warn">
                <div className="font-medium">{t('a2ui.error.title')}</div>
                <div className="break-words text-muted-foreground">{segment.message}</div>
                {onFollowUp && session.closed && (
                  <Button size="sm" variant="outline" className="mt-1 h-6 text-xs" onClick={() => onFollowUp(repairPrompt(segment.message), {})}>
                    {t('a2ui.error.fix')}
                  </Button>
                )}
              </Note>
            </div>
          );
        }
        return segment.surfaceIds.map((id) => <SurfaceView key={`s${i}:${id}`} processor={session.processor} surfaceId={id} />);
      })}
    </A2uiRuntimeContext.Provider>
  );
}
