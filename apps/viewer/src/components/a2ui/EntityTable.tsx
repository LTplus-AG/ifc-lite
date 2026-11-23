/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * EntityTable: rows from a live query or bound script rows; columns are field
 * paths. Click (or Enter / Space on) a row to select and frame it in 3D.
 * Headers sort numeric-aware; `sort` sets the initial order; `groupBy` adds
 * group header rows; `maxRows` pages.
 */

import { Fragment, useMemo, useState, type KeyboardEvent } from 'react';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight } from 'lucide-react';
import { createComponentImplementation } from '@a2ui/react';
import { encodeRef } from '@ifc-lite/a2ui';
import { EntityTableApi } from '@ifc-lite/a2ui/catalog';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { weightStyle } from './basic-layout';
import { groupEntityRows, initialSort, isColumn, nextSort, rowsFromData, rowsFromQuery, sortRows, type Column, type EntityRow, type SortState } from './entity-rows';
import { Note, ResultNotes } from './notes';
import { formatValue, useA2uiRuntime, useQueryResult, useRunFunction } from './runtime';

const DEFAULT_PAGE = 50;

export function useSelectAndFly(): (row: EntityRow) => void {
  const run = useRunFunction();
  return (row) => {
    if (!row.ref || !row.live) return;
    const args = { refs: [encodeRef(row.ref)] };
    run('select', args);
    run('flyTo', args);
  };
}

function rowKeyHandler(activate: () => void) {
  return (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activate();
    }
  };
}

export const EntityTableImpl = createComponentImplementation(EntityTableApi, ({ props }) => {
  const { t } = useTranslation();
  const { host } = useA2uiRuntime();
  const { result, reader } = useQueryResult(props.rows === undefined ? props.query ?? {} : undefined);
  const given = (Array.isArray(props.columns) ? props.columns : []).filter(isColumn);
  const columns: Column[] = given.length ? given : [{ path: 'name' }];
  const sortKey = JSON.stringify(props.sort ?? null);
  const [sort, setSort] = useState<SortState | null>(() => initialSort(props.sort));
  const [sortSource, setSortSource] = useState(sortKey);
  if (sortSource !== sortKey) {
    // The agent changed the initial sort while streaming: adopt it.
    setSortSource(sortKey);
    setSort(initialSort(props.sort));
  }
  const [page, setPage] = useState(0);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const selectAndFly = useSelectAndFly();

  const { rows, unloadedModels } = useMemo(() => {
    if (props.rows !== undefined) return rowsFromData(props.rows, host, reader);
    return { rows: result ? rowsFromQuery(result, reader) : [], unloadedModels: [] as string[] };
  }, [props.rows, result, host, reader]);

  const sorted = useMemo(() => sortRows(rows, sort), [rows, sort]);
  const pageSize = typeof props.maxRows === 'number' && props.maxRows > 0 ? Math.max(1, Math.floor(props.maxRows)) : DEFAULT_PAGE;
  const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const current = Math.min(page, pages - 1);
  const visible = sorted.slice(current * pageSize, (current + 1) * pageSize);
  const groups = groupEntityRows(visible, props.groupBy, t('a2ui.noGroupValue'));
  const noValue = t('a2ui.noValue');
  const title = typeof props.title === 'string' ? props.title : undefined;

  const activate = (row: EntityRow) => {
    setActiveKey(row.key);
    selectAndFly(row);
  };

  return (
    <div style={weightStyle(props.weight)} className="flex min-w-0 flex-col gap-1.5">
      {title && <div className="text-sm font-semibold">{title}</div>}
      <ResultNotes result={result} unloadedModels={unloadedModels} />
      {rows.length === 0 ? (
        result?.unloadedModel ? null : <Note>{t('a2ui.empty')}</Note>
      ) : (
        <div className="max-h-96 overflow-auto rounded-md border">
          <Table className="text-xs">
            <TableHeader className="sticky top-0 bg-background">
              <TableRow>
                {columns.map((col) => {
                  const label = col.label ?? col.path;
                  const dir = sort?.path === col.path ? sort.dir : null;
                  return (
                    <TableHead key={col.path} aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none'} className="h-8 px-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 gap-1 px-1 text-xs font-medium"
                        aria-label={t('a2ui.table.sortBy', { column: label })}
                        onClick={() => { setSort(nextSort(sort, col.path)); setPage(0); }}
                      >
                        {label}
                        {dir === 'asc' && <ArrowUp className="h-3 w-3" aria-hidden />}
                        {dir === 'desc' && <ArrowDown className="h-3 w-3" aria-hidden />}
                      </Button>
                    </TableHead>
                  );
                })}
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map((group) => (
                <Fragment key={`g:${group.label}`}>
                  {props.groupBy && (
                    <TableRow className="bg-muted/50 hover:bg-muted/50">
                      <TableCell colSpan={columns.length} className="px-2 py-1 font-semibold">
                        {t('a2ui.table.group', { group: group.label, count: group.rows.length })}
                      </TableCell>
                    </TableRow>
                  )}
                  {group.rows.map((row) => (
                    <TableRow
                      key={row.key}
                      data-a2ui-row={row.ref ? encodeRef(row.ref) : undefined}
                      tabIndex={row.live ? 0 : -1}
                      aria-label={row.live ? t('a2ui.table.rowLabel', { name: row.label }) : undefined}
                      aria-selected={activeKey === row.key}
                      aria-disabled={!row.live || undefined}
                      onClick={() => activate(row)}
                      onKeyDown={rowKeyHandler(() => activate(row))}
                      className={cn(row.live ? 'cursor-pointer' : 'opacity-60', activeKey === row.key && 'bg-active-surface')}
                    >
                      {columns.map((col) => (
                        <TableCell key={col.path} className="max-w-64 truncate px-2 py-1">{formatValue(row.read(col.path), noValue)}</TableCell>
                      ))}
                    </TableRow>
                  ))}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {rows.length > 0 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{t('a2ui.table.caption', { shown: visible.length.toLocaleString(), total: sorted.length.toLocaleString() })}</span>
          {pages > 1 && (
            <span className="flex items-center gap-1">
              <IconButton size="icon-xs" variant="ghost" label={t('a2ui.table.previous')} disabled={current === 0} onClick={() => setPage(current - 1)}>
                <ChevronLeft className="h-3.5 w-3.5" />
              </IconButton>
              <span>{t('a2ui.table.page', { page: current + 1, pages })}</span>
              <IconButton size="icon-xs" variant="ghost" label={t('a2ui.table.next')} disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>
                <ChevronRight className="h-3.5 w-3.5" />
              </IconButton>
            </span>
          )}
        </div>
      )}
    </div>
  );
});
