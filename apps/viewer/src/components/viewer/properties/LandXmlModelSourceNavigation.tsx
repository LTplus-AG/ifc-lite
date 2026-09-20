/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from '@/i18n';
import type { LandXmlSourceRef, LandXmlTinDocument } from '@/hooks/ingest/landXmlSemantics';

const SURFACE_PAGE_SIZE = 100;
const OVERLAY_PAGE_SIZE = 100;

interface LandXmlModelSourceNavigationProps {
  modelId: string;
  document: LandXmlTinDocument;
  selected: LandXmlSourceRef | null;
  onSelect(ref: LandXmlSourceRef): void;
}

/** Bounded model-level entry points for every retained LandXML source surface. */
export function LandXmlModelSourceNavigation({ modelId, document, selected, onSelect }: LandXmlModelSourceNavigationProps) {
  const { t } = useTranslation();
  const [surfacePage, setSurfacePage] = useState(0);
  const [overlayPage, setOverlayPage] = useState(0);
  const pages = Math.max(1, Math.ceil(document.surfaces.length / SURFACE_PAGE_SIZE));
  const page = Math.min(surfacePage, pages - 1);
  const surfaces = useMemo(() => document.surfaces.slice(
    page * SURFACE_PAGE_SIZE,
    (page + 1) * SURFACE_PAGE_SIZE,
  ), [document.surfaces, page]);
  const overlayCount = useMemo(() => document.surfaces.reduce(
    (total, surface) => total + surface.boundaries.length + surface.breaklines.length + surface.contours.length,
    0,
  ), [document.surfaces]);
  const overlayPages = Math.max(1, Math.ceil(overlayCount / OVERLAY_PAGE_SIZE));
  const boundedOverlayPage = Math.min(overlayPage, overlayPages - 1);
  const overlays = useMemo(() => {
    const start = boundedOverlayPage * OVERLAY_PAGE_SIZE;
    const end = start + OVERLAY_PAGE_SIZE;
    const pageRecords: Array<{ label: string; sourceId: string; name: string | null }> = [];
    let ordinal = 0;
    for (const surface of document.surfaces) {
      for (const [label, lines] of [
        ['Boundary', surface.boundaries],
        ['Breakline', surface.breaklines],
        ['Contour', surface.contours],
      ] as const) {
        for (const line of lines) {
          if (ordinal >= start && ordinal < end) pageRecords.push({ label, sourceId: line.sourceId, name: line.name });
          ordinal += 1;
          if (ordinal >= end) return pageRecords;
        }
      }
    }
    return pageRecords;
  }, [boundedOverlayPage, document.surfaces]);

  useEffect(() => {
    setSurfacePage(0);
    setOverlayPage(0);
  }, [modelId, document]);

  return <>
    <div className="border-b border-zinc-200 dark:border-zinc-800">
      <div className="p-3 bg-zinc-50 dark:bg-zinc-900/50">
        <h4 className="font-bold text-xs uppercase tracking-wide text-zinc-700 dark:text-zinc-300">{t('properties.modelMetadata.sourceSurfaceRecords')}</h4>
      </div>
      <div className="divide-y divide-zinc-100 dark:divide-zinc-900">
        {surfaces.map((surface) => {
          const isSelected = selected?.modelId === modelId && selected.sourceId === surface.sourceId;
          return <button key={surface.sourceId} type="button"
            className={`flex w-full items-center gap-3 px-3 py-2 text-left text-xs ${isSelected ? 'bg-primary/10 text-primary' : 'text-zinc-700 dark:text-zinc-300'}`}
            onClick={() => onSelect({ modelId, sourceId: surface.sourceId })}>
            <span className="font-mono">{surface.kind}</span>
            <span className="truncate">{surface.name}</span>
            <span className="ml-auto font-mono text-zinc-500">{surface.renderState}</span>
          </button>;
        })}
      </div>
      {pages > 1 && <div className="flex items-center justify-between border-t border-zinc-200 px-3 py-2 text-xs dark:border-zinc-800">
        <button type="button" disabled={page === 0} onClick={() => setSurfacePage(page - 1)}>{t('properties.landXmlSource.previous')}</button>
        <span>{t('properties.landXmlSource.page', { current: page + 1, total: pages })}</span>
        <button type="button" disabled={page + 1 >= pages} onClick={() => setSurfacePage(page + 1)}>{t('properties.landXmlSource.next')}</button>
      </div>}
    </div>
    <div className="border-b border-zinc-200 dark:border-zinc-800">
      <div className="p-3 bg-zinc-50 dark:bg-zinc-900/50">
        <h4 className="font-bold text-xs uppercase tracking-wide text-zinc-700 dark:text-zinc-300">{t('properties.modelMetadata.sourceOverlays')}</h4>
      </div>
      <div className="divide-y divide-zinc-100 dark:divide-zinc-900">
        {overlays.length === 0 ? <div className="px-3 py-2 text-xs text-zinc-500">{t('properties.modelMetadata.noSourceOverlays')}</div> : overlays.map((overlay) => {
          const isSelected = selected?.modelId === modelId && selected.sourceId === overlay.sourceId;
          return <button key={overlay.sourceId} type="button"
            className={`flex w-full items-center gap-3 px-3 py-2 text-left text-xs ${isSelected ? 'bg-primary/10 text-primary' : 'text-zinc-700 dark:text-zinc-300'}`}
            onClick={() => onSelect({ modelId, sourceId: overlay.sourceId })}>
            <span className="font-mono">{overlay.label}</span>
            <span className="truncate">{overlay.name ?? overlay.sourceId}</span>
          </button>;
        })}
      </div>
      {overlayPages > 1 && <div className="flex items-center justify-between border-t border-zinc-200 px-3 py-2 text-xs dark:border-zinc-800">
        <button type="button" disabled={boundedOverlayPage === 0} onClick={() => setOverlayPage(boundedOverlayPage - 1)}>{t('properties.landXmlSource.previous')}</button>
        <span>{t('properties.landXmlSource.page', { current: boundedOverlayPage + 1, total: overlayPages })}</span>
        <button type="button" disabled={boundedOverlayPage + 1 >= overlayPages} onClick={() => setOverlayPage(boundedOverlayPage + 1)}>{t('properties.landXmlSource.next')}</button>
      </div>}
    </div>
  </>;
}
