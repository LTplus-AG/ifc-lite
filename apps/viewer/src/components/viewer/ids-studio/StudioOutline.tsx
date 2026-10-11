/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Studio outline (IDS-031): a virtualised WAI-ARIA tree of specifications,
 * their applicability and requirement facets. Rows carry a status dot from the
 * lint, the cardinality badge, the facet as a sentence and a count slot that
 * the model loop (P-05) fills; without it the slot reads "—".
 */

import { useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown, ChevronRight, Diamond, FileText, Plus, Search } from 'lucide-react';
import { describeFacet, type LintSeverity, type StudioDocument } from '@ifc-lite/ids-authoring';
import { useTranslation, type TranslationKey } from '@/i18n';
import { useViewerStore } from '@/store';
import { outlineKey, outlineRows, type OutlineRow } from '@/lib/ids-studio/outline';
import { addSpecOps } from '@/lib/ids-studio/ops';
import { specCardinality } from '@/lib/ids-studio/spec-cardinality';
import { cn } from '@/lib/utils';
import { SeverityIcon } from './DiagnosticItem';
import { useDiagnosticsContext } from './useStudio';

const ROW = 28;
const BADGE: Record<'required' | 'optional' | 'prohibited', { short: TranslationKey; long: TranslationKey; tone: string }> = {
  required: { short: 'idsStudio.badge.required', long: 'idsStudio.cardinality.required', tone: 'border-primary/40 text-primary' },
  optional: { short: 'idsStudio.badge.optional', long: 'idsStudio.cardinality.optional', tone: 'border-border text-muted-foreground' },
  prohibited: { short: 'idsStudio.badge.prohibited', long: 'idsStudio.cardinality.prohibited', tone: 'border-destructive/40 text-destructive' },
};
const DOT: Record<LintSeverity | 'ok', string> = { error: 'bg-destructive', warning: 'bg-amber-500', info: 'bg-sky-500', ok: 'bg-emerald-500' };

function Badge({ value }: { value: 'required' | 'optional' | 'prohibited' }) {
  const { t } = useTranslation();
  return <abbr title={t(BADGE[value].long)} className={cn('shrink-0 rounded border px-1 text-2xs font-semibold no-underline', BADGE[value].tone)}>{t(BADGE[value].short)}</abbr>;
}

function CountSlot() {
  const { t } = useTranslation();
  return <span className="ml-auto shrink-0 pl-1 text-2xs tabular-nums text-muted-foreground" title={t('idsStudio.outline.countNoModel')}>—</span>;
}

export function StudioOutline({ doc }: { doc: StudioDocument }) {
  const { t } = useTranslation();
  const locale = useViewerStore((s) => s.idsLocale);
  const selection = useViewerStore((s) => s.idsStudioSelection);
  const select = useViewerStore((s) => s.idsStudioSelect);
  const dispatch = useViewerStore((s) => s.idsStudioDispatch);
  const { severity } = useDiagnosticsContext();
  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [active, setActive] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => outlineRows(doc, collapsed, filter), [doc, collapsed, filter]);
  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => scrollRef.current, estimateSize: () => ROW, overscan: 10 });
  const focused = active ?? selection;

  const toggle = (id: string, open?: boolean) => setCollapsed((prev) => {
    const next = new Set(prev);
    const shouldOpen = open ?? next.has(id);
    if (shouldOpen) next.delete(id); else next.add(id);
    return next;
  });
  // Row clicks are delegated to the tree (rows are not focusable: the tree
  // owns focus and points at the active row with aria-activedescendant).
  const onTreeClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const id = target.closest('[data-row-id]')?.getAttribute('data-row-id');
    const row = id ? rows.find((r) => r.id === id) : undefined;
    if (!row) return;
    if (target.closest('[data-row-toggle]')) { toggle(row.id); return; }
    activate(row);
  };
  const activate = (row: OutlineRow) => {
    setActive(row.id);
    if (row.kind === 'section') { toggle(row.id); select(row.specId); } else select(row.id);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      const row = rows.find((r) => r.id === focused);
      if (row) { event.preventDefault(); activate(row); }
      return;
    }
    const action = outlineKey(rows, focused, event.key, collapsed);
    if (action.kind === 'none') return;
    event.preventDefault();
    if (action.kind === 'focus') {
      setActive(action.id);
      const index = rows.findIndex((r) => r.id === action.id);
      if (index >= 0) virtualizer.scrollToIndex(index);
    } else toggle(action.id, action.kind === 'expand');
  };
  const addSpec = () => {
    const last = doc.ids.specifications[doc.ids.specifications.length - 1];
    const { ops, specId } = addSpecOps({ name: t('idsStudio.outline.newSpecName'), ifcVersions: last?.ifcVersions.length ? last.ifcVersions : ['IFC4'] });
    if (dispatch(ops, { label: t('idsStudio.outline.addSpec') }).ok) { select(specId); setActive(specId); }
  };

  const label = (row: OutlineRow): string => {
    if (row.kind === 'spec') return doc.ids.specifications[row.specIndex].name || t('idsStudio.outline.unnamed');
    if (row.kind === 'section') return t(row.section === 'applicability' ? 'idsStudio.outline.appliesTo' : 'idsStudio.outline.requires');
    return describeFacet(row.facet, row.section, row.optionality, locale);
  };

  return <div className="flex h-full min-h-0 flex-col">
    <div className="flex items-center gap-1 border-b border-border px-2 py-1">
      <Search className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
      <input aria-label={t('idsStudio.outline.filter')} placeholder={t('idsStudio.outline.filter')} value={filter} onChange={(event) => setFilter(event.target.value)}
        className="h-6 min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground" />
    </div>
    <button type="button" onClick={() => { select(doc.nodes.document); setActive(null); }}
      className={cn('flex items-center gap-1.5 px-2 py-1 text-left text-xs hover:bg-muted', selection === doc.nodes.document && 'bg-accent')}>
      <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="truncate font-medium">{doc.ids.info.title || t('idsStudio.outline.untitled')}</span>
      {severity.get(doc.nodes.document) && <SeverityIcon severity={severity.get(doc.nodes.document) as LintSeverity} />}
    </button>
    <div ref={scrollRef} role="tree" aria-label={t('idsStudio.outline.label')} tabIndex={0} onKeyDown={onKeyDown} onClick={onTreeClick}
      aria-activedescendant={focused && rows.some((r) => r.id === focused) ? `outline-${focused}` : undefined}
      className="min-h-0 flex-1 overflow-auto focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring">
      {rows.length === 0 && <p className="px-2 py-3 text-xs text-muted-foreground">{filter ? t('idsStudio.outline.noMatch') : t('idsStudio.outline.empty')}</p>}
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];
          const open = row.expandable && !collapsed.has(row.id);
          const sev = row.kind === 'section' ? undefined : severity.get(row.id);
          return <div key={row.id} id={`outline-${row.id}`} data-row-id={row.id} role="treeitem" aria-level={row.depth} aria-selected={selection === row.id}
            aria-expanded={row.expandable ? open : undefined}
            style={{ position: 'absolute', top: item.start, left: 0, right: 0, height: ROW, paddingLeft: 4 + (row.depth - 1) * 14 }}
            className={cn('flex cursor-pointer items-center gap-1.5 pr-2 text-xs', selection === row.id ? 'bg-accent' : 'hover:bg-muted', focused === row.id && 'ring-1 ring-inset ring-ring')}>
            {row.expandable
              ? <span aria-hidden data-row-toggle>{open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}</span>
              : <span className="w-3" aria-hidden />}
            {row.kind === 'spec' && <span aria-hidden className={cn('h-2 w-2 shrink-0 rounded-full', DOT[sev ?? 'ok'])} />}
            {row.kind === 'spec' && <Badge value={specCardinality(doc.ids.specifications[row.specIndex])} />}
            {row.kind === 'facet' && <Diamond className={cn('h-3 w-3 shrink-0', row.section === 'applicability' ? 'text-sky-600' : 'text-violet-600')} aria-hidden />}
            {row.kind === 'facet' && row.optionality && row.facet.type !== 'entity' && <Badge value={row.optionality} />}
            <span className={cn('min-w-0 truncate', row.kind === 'section' && 'text-2xs uppercase tracking-wide text-muted-foreground', row.kind === 'spec' && 'font-medium')}>{label(row)}</span>
            {row.kind === 'section' && <span className="text-2xs text-muted-foreground">({row.count})</span>}
            {sev && row.kind === 'facet' && <SeverityIcon severity={sev} />}
            {row.kind !== 'section' && <CountSlot />}
          </div>;
        })}
      </div>
    </div>
    <button type="button" onClick={addSpec} className="flex items-center gap-1.5 border-t border-border px-2 py-1.5 text-left text-xs text-primary hover:bg-muted">
      <Plus className="h-3.5 w-3.5" aria-hidden />{t('idsStudio.outline.addSpec')}
    </button>
  </div>;
}
