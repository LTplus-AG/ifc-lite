/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo, type ReactNode } from 'react';
import { Boxes, Calculator, ChevronDown, FileText, Layers, ListTree, MousePointer2, Tag } from 'lucide-react';
import { CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useTranslation } from '@/i18n';
import { localeCount } from '@/i18n/intlFormat';
import { useViewerStore } from '@/store';
import { stringToEntityRef } from '@/store/entity-ref';
import type { FederatedModel } from '@/store/types';
import type { IfcDataStore } from '@ifc-lite/parser';
import { TOUR_ANCHORS, tourAnchor } from '@/lib/tours/anchors';
import { CopyValueButton } from './CopyValueButton';
import { PersistentCollapsible } from './PersistentCollapsible';
import { UnitDisplayControl } from './UnitDisplayControl';
import { AssistantAction } from '@/components/viewer/assistant/AssistantAction';
import { summarizeSelection, type SummaryRow } from './selectionSummary';
import { selectOnlyEntity } from './useSelectAssembly';

/** Element rows listed before the rest collapse into "N more elements". */
const ELEMENT_LIST_LIMIT = 50;

function Section({ id, icon, title, count, children }: { id: string; icon: ReactNode; title: string; count: number; children: ReactNode }) {
  return (
    <PersistentCollapsible id={`summary-${id}`} className="border-b">
      <CollapsibleTrigger className="group/disclosure flex items-center gap-2 w-full p-3 hover:bg-muted/50 text-left">
        {icon}
        <span className="font-medium text-sm">{title}</span>
        <span className="text-xs text-muted-foreground ml-auto">{count}</span>
        <ChevronDown className="size-3 transition-transform group-data-[state=closed]/disclosure:-rotate-90" aria-hidden="true" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="divide-y border-t">{children}</div>
      </CollapsibleContent>
    </PersistentCollapsible>
  );
}

function ValueRow({ row }: { row: SummaryRow }) {
  const { t, locale } = useTranslation();
  return (
    <div className="group/copyrow grid grid-cols-[minmax(80px,1fr)_minmax(0,2fr)] gap-2 px-3 py-1.5 text-sm">
      <span className="text-muted-foreground truncate" title={row.name}>{row.name}</span>
      <div className="flex items-center gap-1 min-w-0">
        {row.value === null ? (
          <span className="flex-1 italic text-muted-foreground">{t('properties.summary.varies', localeCount(locale, row.distinct))}</span>
        ) : (
          <>
            <span className="flex-1 min-w-0 truncate font-medium" title={row.value}>{row.value}</span>
            <CopyValueButton name={row.name} value={row.value} />
          </>
        )}
      </div>
    </div>
  );
}

/**
 * What the Properties panel shows for a multi-selection (#5900), instead of
 * silently showing only the primary element: counts per class and per model,
 * the attributes / properties / quantities every element shares (their common
 * value, or how many different values), and the elements themselves, each of
 * which narrows the selection to itself.
 */
export function SelectionSummaryPanel({ models, ifcDataStore }: { models: Map<string, FederatedModel>; ifcDataStore: IfcDataStore | null }) {
  const { t, locale } = useTranslation();
  const selectedEntitiesSet = useViewerStore((s) => s.selectedEntitiesSet);
  const mutationViews = useViewerStore((s) => s.mutationViews);
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const unitDisplayOverrides = useViewerStore((s) => s.unitDisplayOverrides);

  // `mutationVersion` is a dependency on purpose: edits land in the same view
  // objects, so the map identity alone would keep showing pre-edit values.
  const summary = useMemo(() => summarizeSelection(
    [...selectedEntitiesSet].map(stringToEntityRef).filter((ref) => ref.expressId > 0),
    (modelId) => {
      const legacy = modelId === 'legacy' || modelId === '__legacy__';
      const model = legacy ? null : models.get(modelId);
      const store = model?.ifcDataStore ?? (legacy ? ifcDataStore : null);
      return { store, view: mutationViews.get(legacy ? '__legacy__' : modelId), modelName: model?.name ?? modelId };
    },
    unitDisplayOverrides,
    locale,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [selectedEntitiesSet, models, ifcDataStore, mutationViews, mutationVersion, unitDisplayOverrides, locale]);

  const shownElements = summary.elements.slice(0, ELEMENT_LIST_LIMIT);
  const propertyRowCount = summary.properties.reduce((n, g) => n + g.rows.length, 0);
  const quantityRowCount = summary.quantities.reduce((n, g) => n + g.rows.length, 0);
  const groupHeading = (name: string) => (
    <div className="px-3 py-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground bg-muted/30 truncate" title={name}>{name}</div>
  );

  return (
    <div {...tourAnchor(TOUR_ANCHORS.propertiesPanel)} className="h-full flex flex-col border-l-2 border-zinc-200 dark:border-zinc-800 bg-white dark:bg-black">
      <div className="p-3 border-b-2 border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-black flex items-center gap-2">
        <Boxes className="h-4 w-4 text-emerald-600" aria-hidden="true" />
        <h2 className="font-bold uppercase tracking-wider text-xs text-zinc-900 dark:text-zinc-100">
          {t('properties.summary.elementCount', localeCount(locale, summary.total))}
        </h2>
        <div className="ml-auto flex items-center gap-1"><AssistantAction /><UnitDisplayControl /></div>
      </div>
      <ScrollArea className="flex-1">
        <Section id="classes" icon={<Layers className="h-4 w-4 text-muted-foreground" />} title={t('properties.summary.byClassHeading')} count={summary.byClass.length}>
          {summary.byClass.map((row) => (
            <div key={row.label} className="flex justify-between gap-2 px-3 py-1.5 text-sm">
              <span className="font-mono truncate">{row.label}</span>
              <span className="font-mono tabular-nums">{row.count}</span>
            </div>
          ))}
        </Section>
        <Section id="models" icon={<ListTree className="h-4 w-4 text-muted-foreground" />} title={t('properties.summary.byModelHeading')} count={summary.byModel.length}>
          {summary.byModel.map((row) => (
            <div key={row.modelId} className="flex justify-between gap-2 px-3 py-1.5 text-sm">
              <span className="truncate" title={row.label}>{row.label}</span>
              <span className="font-mono tabular-nums">{row.count}</span>
            </div>
          ))}
        </Section>
        {summary.compared < summary.total && (
          <p className="px-3 py-2 text-xs text-muted-foreground border-b">
            {t('properties.summary.valuesCapped', { limit: summary.compared, total: summary.total })}
          </p>
        )}
        {summary.attributes.length + propertyRowCount + quantityRowCount === 0 && (
          <p className="px-3 py-4 text-sm text-muted-foreground text-center border-b">{t('properties.summary.noShared')}</p>
        )}
        {summary.attributes.length > 0 && (
          <Section id="attributes" icon={<Tag className="h-4 w-4 text-muted-foreground" />} title={t('properties.summary.attributesHeading')} count={summary.attributes.length}>
            {summary.attributes.map((row) => <ValueRow key={row.name} row={row} />)}
          </Section>
        )}
        {propertyRowCount > 0 && (
          <Section id="properties" icon={<FileText className="h-4 w-4 text-muted-foreground" />} title={t('properties.summary.propertiesHeading')} count={propertyRowCount}>
            {summary.properties.map((group) => (
              <div key={group.name} className="divide-y">
                {groupHeading(group.name)}
                {group.rows.map((row, i) => <ValueRow key={`${row.name}-${i}`} row={row} />)}
              </div>
            ))}
          </Section>
        )}
        {quantityRowCount > 0 && (
          <Section id="quantities" icon={<Calculator className="h-4 w-4 text-muted-foreground" />} title={t('properties.summary.quantitiesHeading')} count={quantityRowCount}>
            {summary.quantities.map((group) => (
              <div key={group.name} className="divide-y">
                {groupHeading(group.name)}
                {group.rows.map((row, i) => <ValueRow key={`${row.name}-${i}`} row={row} />)}
              </div>
            ))}
          </Section>
        )}
        <Section id="elements" icon={<MousePointer2 className="h-4 w-4 text-muted-foreground" />} title={t('properties.summary.elementsHeading')} count={summary.total}>
          {shownElements.map((element) => (
            <button
              key={`${element.ref.modelId}:${element.ref.expressId}`}
              type="button"
              aria-label={t('properties.summary.selectOnly', { name: element.name })}
              className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
              onClick={() => selectOnlyEntity(element.ref)}
            >
              <span className="truncate font-medium">{element.name}</span>
              <span className="shrink-0 font-mono text-xs text-muted-foreground">{element.className}</span>
            </button>
          ))}
          {summary.total > shownElements.length && (
            <p className="px-3 py-1.5 text-xs text-muted-foreground">
              {t('properties.summary.moreElements', localeCount(locale, summary.total - shownElements.length))}
            </p>
          )}
        </Section>
      </ScrollArea>
    </div>
  );
}
