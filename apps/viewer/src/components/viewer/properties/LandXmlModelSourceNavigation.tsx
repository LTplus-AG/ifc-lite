/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from '@/i18n';
import type { LandXmlSourceRef, LandXmlTinDocument } from '@/hooks/ingest/landXmlSemantics';

const PAGE_SIZE = 100;
const DIAGNOSTIC_PAGE_SIZE = 20;

interface LandXmlModelSourceNavigationProps {
  modelId: string;
  document: LandXmlTinDocument;
  selected: LandXmlSourceRef | null;
  onSelect(ref: LandXmlSourceRef): void;
}

type NavigationRecord = { label: string; sourceId: string; detail?: string };

function sourceRecordCount(document: LandXmlTinDocument): number {
  return document.alignments.length + document.profiles.length + document.crossSections.length
    + document.crossSectionSurfaces.length + document.roadways.length + document.preservedOnlyExtensions.length;
}

/** Return one semantic record by index without copying a large source collection. */
function sourceRecordAt(document: LandXmlTinDocument, itemIndex: number): NavigationRecord {
  let index = itemIndex;
  const alignment = document.alignments[index];
  if (alignment) return { label: `Alignment: ${alignment.name}`, sourceId: alignment.sourceId };
  index -= document.alignments.length;
  const profile = document.profiles[index];
  if (profile) return { label: `Profile: ${profile.name}`, sourceId: profile.sourceId, detail: profile.kind };
  index -= document.profiles.length;
  const crossSection = document.crossSections[index];
  if (crossSection) return { label: `Cross section ${crossSection.ordinal}`, sourceId: crossSection.sourceId, detail: `sta ${crossSection.station}` };
  index -= document.crossSections.length;
  const crossSectionSurface = document.crossSectionSurfaces[index];
  if (crossSectionSurface) return { label: `Cross-section surface: ${crossSectionSurface.name?.trim() || crossSectionSurface.sourceId}`, sourceId: crossSectionSurface.sourceId, detail: crossSectionSurface.kind };
  index -= document.crossSectionSurfaces.length;
  const roadway = document.roadways[index];
  if (roadway) return { label: `Roadway: ${roadway.name}`, sourceId: roadway.sourceId };
  index -= document.roadways.length;
  const extension = document.preservedOnlyExtensions[index];
  if (extension) return { label: `Source-only: ${extension.localName}`, sourceId: extension.sourceId, detail: extension.kind };
  throw new Error(`LandXML semantic navigation index ${itemIndex} is outside the retained records`);
}

function Pager({ page, pages, setPage }: { page: number; pages: number; setPage(page: number): void }) {
  const { t } = useTranslation();
  if (pages <= 1) return null;
  return <div className="flex items-center justify-between border-t border-zinc-200 px-3 py-2 text-xs dark:border-zinc-800">
    <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>{t('properties.landXmlSource.previous')}</button>
    <span>{t('properties.landXmlSource.page', { current: page + 1, total: pages })}</span>
    <button type="button" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>{t('properties.landXmlSource.next')}</button>
  </div>;
}

function RecordButton({ item, modelId, selected, onSelect }: { item: NavigationRecord; modelId: string; selected: LandXmlSourceRef | null; onSelect(ref: LandXmlSourceRef): void }) {
  const isSelected = selected?.modelId === modelId && selected.sourceId === item.sourceId;
  return <button type="button" className={`flex w-full items-center gap-3 px-3 py-2 text-left text-xs ${isSelected ? 'bg-primary/10 text-primary' : 'text-zinc-700 dark:text-zinc-300'}`}
    onClick={() => onSelect({ modelId, sourceId: item.sourceId })}>
    <span className="truncate">{item.label}</span>
    {item.detail && <span className="ml-auto font-mono text-zinc-500">{item.detail}</span>}
  </button>;
}

/** Bounded model-level entry points for retained terrain and review source records. */
export function LandXmlModelSourceNavigation({ modelId, document, selected, onSelect }: LandXmlModelSourceNavigationProps) {
  const { t } = useTranslation();
  const [surfacePage, setSurfacePage] = useState(0);
  const [overlayPage, setOverlayPage] = useState(0);
  const [recordPage, setRecordPage] = useState(0);
  const [diagnosticPage, setDiagnosticPage] = useState(0);
  const [pipePage, setPipePage] = useState(0);
  const pages = Math.max(1, Math.ceil(document.surfaces.length / PAGE_SIZE));
  const page = Math.min(surfacePage, pages - 1);
  const surfaces = useMemo(() => document.surfaces.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE), [document.surfaces, page]);
  const overlayCount = useMemo(() => document.surfaces.reduce(
    (total, surface) => total + surface.boundaries.length + surface.breaklines.length + surface.contours.length,
    0,
  ), [document.surfaces]);
  const overlayPages = Math.max(1, Math.ceil(overlayCount / PAGE_SIZE));
  const boundedOverlayPage = Math.min(overlayPage, overlayPages - 1);
  const overlays = useMemo(() => {
    const start = boundedOverlayPage * PAGE_SIZE;
    const end = start + PAGE_SIZE;
    const pageRecords: NavigationRecord[] = [];
    let ordinal = 0;
    for (const surface of document.surfaces) {
      for (const [label, lines] of [['Boundary', surface.boundaries], ['Breakline', surface.breaklines], ['Contour', surface.contours]] as const) {
        for (const line of lines) {
          if (ordinal >= start && ordinal < end) pageRecords.push({ label: `${label}: ${line.name ?? line.ordinal}`, sourceId: line.sourceId });
          ordinal += 1;
          if (ordinal >= end) return pageRecords;
        }
      }
    }
    return pageRecords;
  }, [boundedOverlayPage, document.surfaces]);
  const recordCount = sourceRecordCount(document);
  const recordPages = Math.max(1, Math.ceil(recordCount / PAGE_SIZE));
  const boundedRecordPage = Math.min(recordPage, recordPages - 1);
  const records = useMemo(() => {
    const first = boundedRecordPage * PAGE_SIZE;
    return Array.from({ length: Math.min(PAGE_SIZE, recordCount - first) }, (_, index) => sourceRecordAt(document, first + index));
  }, [boundedRecordPage, document, recordCount]);
  const diagnosticPages = Math.max(1, Math.ceil(document.capabilityDiagnostics.length / DIAGNOSTIC_PAGE_SIZE));
  const boundedDiagnosticPage = Math.min(diagnosticPage, diagnosticPages - 1);
  const diagnostics = useMemo(() => document.capabilityDiagnostics.slice(
    boundedDiagnosticPage * DIAGNOSTIC_PAGE_SIZE,
    (boundedDiagnosticPage + 1) * DIAGNOSTIC_PAGE_SIZE,
  ), [boundedDiagnosticPage, document.capabilityDiagnostics]);
  const pipes = useMemo(
    () => (document.pipeNetworks?.networks.flatMap((network) => network.pipes) ?? []),
    [document.pipeNetworks],
  );
  const pipePages = Math.max(1, Math.ceil(pipes.length / PAGE_SIZE));
  const boundedPipePage = Math.min(pipePage, pipePages - 1);
  const visiblePipes = pipes.slice(boundedPipePage * PAGE_SIZE, (boundedPipePage + 1) * PAGE_SIZE);

  useEffect(() => {
    setSurfacePage(0);
    setOverlayPage(0);
    setRecordPage(0);
    setDiagnosticPage(0);
    setPipePage(0);
  }, [modelId, document]);

  return <>
    <NavigationSection title={t('properties.modelMetadata.sourceSurfaceRecords')}>
      {surfaces.map((surface) => <RecordButton key={surface.sourceId} item={{ label: `${surface.kind}: ${surface.name}`, sourceId: surface.sourceId, detail: surface.renderState }} modelId={modelId} selected={selected} onSelect={onSelect} />)}
      <Pager page={page} pages={pages} setPage={setSurfacePage} />
    </NavigationSection>
    <NavigationSection title={t('properties.modelMetadata.sourceOverlays')}>
      {overlays.length === 0 ? <div className="px-3 py-2 text-xs text-zinc-500">{t('properties.modelMetadata.noSourceOverlays')}</div> : overlays.map((overlay) => <RecordButton key={overlay.sourceId} item={overlay} modelId={modelId} selected={selected} onSelect={onSelect} />)}
      <Pager page={boundedOverlayPage} pages={overlayPages} setPage={setOverlayPage} />
    </NavigationSection>
    {pipes.length > 0 && <NavigationSection title={t('properties.modelMetadata.sourcePipeRecords')}>
      {visiblePipes.map((pipe) => <RecordButton key={pipe.sourceId} item={{ label: pipe.name, sourceId: pipe.sourceId, detail: pipe.geometry.kind }} modelId={modelId} selected={selected} onSelect={onSelect} />)}
      <Pager page={boundedPipePage} pages={pipePages} setPage={setPipePage} />
    </NavigationSection>}
    <NavigationSection title={t('properties.landXmlSource.reviewRecords')}>
      {records.length === 0 ? <div className="px-3 py-2 text-xs text-zinc-500">{t('properties.landXmlSource.noReviewRecords')}</div> : records.map((record) => <RecordButton key={record.sourceId} item={record} modelId={modelId} selected={selected} onSelect={onSelect} />)}
      <Pager page={boundedRecordPage} pages={recordPages} setPage={setRecordPage} />
    </NavigationSection>
    <NavigationSection title={t('properties.landXmlSource.diagnostics')}>
      {diagnostics.length === 0 ? <div className="px-3 py-2 text-xs text-zinc-500">{t('properties.landXmlSource.noDiagnostics')}</div> : diagnostics.map((diagnostic, index) => <div key={`${diagnostic.sourceId ?? 'document'}:${diagnostic.code}:${index}`} className="px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
        <span className="font-mono">{diagnostic.code}</span><span className="mx-1">—</span>{diagnostic.message}
      </div>)}
      <Pager page={boundedDiagnosticPage} pages={diagnosticPages} setPage={setDiagnosticPage} />
    </NavigationSection>
  </>;
}

function NavigationSection({ title, children }: { title: string; children: ReactNode }) {
  return <div className="border-b border-zinc-200 dark:border-zinc-800">
    <div className="p-3 bg-zinc-50 dark:bg-zinc-900/50"><h4 className="font-bold text-xs uppercase tracking-wide text-zinc-700 dark:text-zinc-300">{title}</h4></div>
    <div className="divide-y divide-zinc-100 dark:divide-zinc-900">{children}</div>
  </div>;
}
