/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS Studio (IDS-030): outline above, inspector or XML below, diagnostics
 * at the foot. Every edit in here is a `@ifc-lite/ids-authoring` op batch that
 * passes the grounding gate (`idsStudioDispatch`); nothing writes the IDS
 * document directly. Lint runs once per document change and is shared.
 */

import { useState, type KeyboardEvent } from 'react';
import { ChevronDown, ChevronUp, Code2, PanelTop, Redo2, Undo2 } from 'lucide-react';
import { canRedo, canUndo } from '@ifc-lite/ids-authoring';
import { IconButton } from '@/components/ui/icon-button';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { tourAnchor, TOUR_ANCHORS } from '@/lib/tours/anchors';
import { cn } from '@/lib/utils';
import { DiagnosticsPanel } from './DiagnosticsPanel';
import { SeverityIcon } from './DiagnosticItem';
import { RejectionBanner } from './RejectionBanner';
import { StudioEmptyState } from './StudioEmptyState';
import { StudioInspector } from './StudioInspector';
import { StudioOutline } from './StudioOutline';
import { XmlPreview } from './XmlPreview';
import { StudioDiagnosticsProvider, useStudioContexts, useStudioDiagnostics } from './useStudio';

export function IdsStudioPanel() {
  const { t } = useTranslation();
  useStudioContexts();
  const state = useViewerStore((s) => s.idsStudioState);
  const view = useViewerStore((s) => s.idsStudioView);
  const setView = useViewerStore((s) => s.idsStudioSetView);
  const undo = useViewerStore((s) => s.idsStudioUndo);
  const redo = useViewerStore((s) => s.idsStudioRedo);
  const ready = useViewerStore((s) => s.idsStudioContexts !== null);
  const diagnostics = useStudioDiagnostics();
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(true);
  if (!state) return <div className="h-full overflow-auto" {...tourAnchor(TOUR_ANCHORS.idsStudioPanel)}><StudioEmptyState /></div>;
  const doc = state.doc;
  // ⌘Z / ⇧⌘Z / ⌘/ (UX spec §7), scoped to the panel so text fields keep their own undo.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (!(event.metaKey || event.ctrlKey) || target.closest('input, textarea, select, [contenteditable="true"]')) return;
    const key = event.key.toLowerCase();
    if (key === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
    else if (key === 'y') { event.preventDefault(); redo(); }
    else if (key === '/') { event.preventDefault(); setView(view === 'xml' ? 'inspector' : 'xml'); }
  };
  const { counts } = diagnostics;
  return <StudioDiagnosticsProvider value={diagnostics}>
    {/* The panel-level shortcuts are a keyboard convenience for the focused panel. */}
    <div className="flex h-full min-h-0 flex-col text-xs" onKeyDown={onKeyDown} role="presentation" {...tourAnchor(TOUR_ANCHORS.idsStudioPanel)}>
      <div className="flex items-center gap-1 border-b border-border px-2 py-1">
        <span className="min-w-0 flex-1 truncate font-semibold" title={doc.ids.info.title}>{doc.ids.info.title || t('idsStudio.outline.untitled')}</span>
        <IconButton label={t('idsStudio.header.undo')} className="h-7 w-7" disabled={!canUndo(state)} onClick={undo}>
          <Undo2 className="h-3.5 w-3.5" aria-hidden />
        </IconButton>
        <IconButton label={t('idsStudio.header.redo')} className="h-7 w-7" disabled={!canRedo(state)} onClick={redo}>
          <Redo2 className="h-3.5 w-3.5" aria-hidden />
        </IconButton>
        <fieldset className="flex rounded border border-border">
          <legend className="sr-only">{t('idsStudio.header.view')}</legend>
          <button type="button" aria-pressed={view === 'inspector'} onClick={() => setView('inspector')}
            className={cn('flex items-center gap-1 px-1.5 py-0.5 text-2xs', view === 'inspector' && 'bg-accent')}><PanelTop className="h-3 w-3" aria-hidden />{t('idsStudio.header.inspector')}</button>
          <button type="button" aria-pressed={view === 'xml'} onClick={() => setView('xml')}
            className={cn('flex items-center gap-1 px-1.5 py-0.5 text-2xs', view === 'xml' && 'bg-accent')}><Code2 className="h-3 w-3" aria-hidden />{t('idsStudio.header.xml')}</button>
        </fieldset>
      </div>
      {!ready && <p className="border-b border-border px-2 py-1 text-2xs text-muted-foreground">{t('idsStudio.loadingSchema')}</p>}
      <div className="min-h-[8rem] flex-[2] border-b border-border"><StudioOutline doc={doc} /></div>
      <div className="min-h-0 flex-[3] overflow-auto">
        <div className="space-y-2 p-2">
          <RejectionBanner />
          {view === 'xml' ? <div className="h-[28rem]"><XmlPreview doc={doc} /></div> : <StudioInspector doc={doc} />}
        </div>
      </div>
      <div className="border-t border-border">
        <button type="button" aria-expanded={diagnosticsOpen} onClick={() => setDiagnosticsOpen((v) => !v)}
          className="flex w-full items-center gap-2 px-2 py-1 text-left text-2xs font-medium hover:bg-muted">
          <span className="flex-1">{t('idsStudio.diagnostics.heading')}</span>
          <span className="flex items-center gap-0.5"><SeverityIcon severity="error" />{counts.error}</span>
          <span className="flex items-center gap-0.5"><SeverityIcon severity="warning" />{counts.warning}</span>
          <span className="flex items-center gap-0.5"><SeverityIcon severity="info" />{counts.info}</span>
          {diagnosticsOpen ? <ChevronDown className="h-3 w-3" aria-hidden /> : <ChevronUp className="h-3 w-3" aria-hidden />}
        </button>
        {diagnosticsOpen && <div className="max-h-48 overflow-auto"><DiagnosticsPanel /></div>}
      </div>
    </div>
  </StudioDiagnosticsProvider>;
}
