/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ColorLegend: one colour per value of a field path, applied to the 3D model
 * through colorize. Manual by default (an Apply button), since colouring the
 * model is a visible change the user should choose; `apply: "onShow"` colours
 * once on first render. Each entry's checkbox hides or shows its group.
 */

import { useEffect, useMemo, useState } from 'react';
import { createComponentImplementation } from '@a2ui/react';
import { parseRefs, type WireEntityRef } from '@ifc-lite/a2ui';
import { ColorLegendApi } from '@ifc-lite/a2ui/catalog';
import { LENS_PALETTE } from '@ifc-lite/lens';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { useTranslation } from '@/i18n';
import { aggregatePool, groupRows } from '@/lib/a2ui/query-eval';
import { weightStyle } from './basic-layout';
import { Note, ResultNotes } from './notes';
import { reportActionError, useA2uiRuntime, useQueryResult } from './runtime';

export interface LegendEntry {
  label: string;
  color: string;
  refs: WireEntityRef[];
}

function legendColor(index: number): string {
  return LENS_PALETTE[index % LENS_PALETTE.length];
}

const HEX = /^#[0-9a-f]{6}$/i;

/** Script data: `[{label, color, refs?}]`; a colour that is not #rrggbb falls back to the palette. */
function legendEntriesFromData(data: unknown): LegendEntry[] | null {
  if (!Array.isArray(data)) return null;
  return data.flatMap((item, i) => {
    if (!item || typeof item !== 'object' || typeof (item as { label?: unknown }).label !== 'string') return [];
    const { label, color, refs } = item as { label: string; color?: unknown; refs?: unknown };
    return [{ label, color: typeof color === 'string' && HEX.test(color) ? color : legendColor(i), refs: parseRefs(refs) }];
  });
}

export const ColorLegendImpl = createComponentImplementation(ColorLegendApi, ({ props }) => {
  const { t } = useTranslation();
  const { host, claimAutoApply } = useA2uiRuntime();
  const { result, reader } = useQueryResult(props.data === undefined ? props.query ?? {} : undefined);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [applied, setApplied] = useState(false);
  const emptyLabel = t('a2ui.noGroupValue');

  const scriptEntries = useMemo(() => legendEntriesFromData(props.data), [props.data]);
  const entries: LegendEntry[] = useMemo(() => {
    if (scriptEntries) return scriptEntries;
    if (!result) return [];
    return groupRows(reader, aggregatePool(result), props.by, emptyLabel)
      .map((g, i) => ({ label: g.label, color: legendColor(i), refs: g.rows.map((r) => r.ref) }));
  }, [scriptEntries, result, reader, props.by, emptyLabel]);

  const apply = () => {
    try {
      // Colouring is a view change on the user's click: the host only ever touches loaded models.
      host.colorize(entries.map((e) => ({ refs: e.refs, color: e.color })));
      setApplied(true);
    } catch (error) {
      reportActionError(error, t);
    }
  };

  useEffect(() => {
    if (props.apply !== 'onShow' || entries.length === 0) return;
    if (!claimAutoApply?.(JSON.stringify([props.by, props.query ?? null, props.data ?? null]))) return;
    apply();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when entries first exist
  }, [props.apply, entries.length]);

  const toggle = (entry: LegendEntry, visible: boolean) => {
    try {
      if (visible) host.show(entry.refs);
      else host.hide(entry.refs);
      setHidden((prev) => {
        const next = new Set(prev);
        if (visible) next.delete(entry.label);
        else next.add(entry.label);
        return next;
      });
    } catch (error) {
      reportActionError(error, t);
    }
  };

  const title = typeof props.title === 'string' ? props.title : undefined;
  return (
    <div style={weightStyle(props.weight)} className="flex min-w-0 flex-col gap-1.5">
      {title && <div className="text-sm font-semibold">{title}</div>}
      {!scriptEntries && <ResultNotes result={result} shown={result?.total} />}
      {entries.length === 0 && (scriptEntries || !result?.unloadedModel) && <Note>{t('a2ui.empty')}</Note>}
      <ul className="flex flex-col gap-0.5 text-xs">
        {entries.map((entry) => (
          <li key={entry.label} data-a2ui-legend={entry.label} className="flex items-center gap-2">
            <Checkbox
              checked={!hidden.has(entry.label)}
              onCheckedChange={(checked) => toggle(entry, checked)}
              aria-label={t('a2ui.legend.toggle', { value: entry.label })}
            />
            <span aria-hidden className="h-3 w-3 shrink-0 rounded-sm border" style={{ backgroundColor: entry.color }} />
            <span className="min-w-0 flex-1 truncate">{entry.label}</span>
            <span className="tabular-nums text-muted-foreground">{entry.refs.length.toLocaleString()}</span>
          </li>
        ))}
      </ul>
      {entries.length > 0 && (
        <div className="flex gap-1.5">
          <Button size="sm" variant={applied ? 'outline' : 'default'} onClick={apply}>
            {applied ? t('a2ui.legend.applied') : t('a2ui.legend.apply')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => { host.resetView(); setApplied(false); setHidden(new Set()); }}>
            {t('a2ui.legend.reset')}
          </Button>
        </div>
      )}
    </div>
  );
});
