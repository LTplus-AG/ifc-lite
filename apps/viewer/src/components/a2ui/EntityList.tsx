/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** EntityList: a compact clickable list of entities from a query or bound refs. */

import { useMemo, useState } from 'react';
import { createComponentImplementation } from '@a2ui/react';
import { encodeRef } from '@ifc-lite/a2ui';
import { EntityListApi } from '@ifc-lite/a2ui/catalog';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { weightStyle } from './basic-layout';
import { rowsFromQuery, rowsFromRefs } from './entity-rows';
import { useSelectAndFly } from './EntityTable';
import { Note, ResultNotes } from './notes';
import { useA2uiRuntime, useQueryResult } from './runtime';

export const EntityListImpl = createComponentImplementation(EntityListApi, ({ props }) => {
  const { t } = useTranslation();
  const { host } = useA2uiRuntime();
  const labelPath = typeof props.label === 'string' && props.label ? props.label : 'name';
  const { result, reader } = useQueryResult(props.refs === undefined ? props.query ?? {} : undefined);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const selectAndFly = useSelectAndFly();
  const { rows, unloadedModels } = useMemo(() => {
    if (props.refs !== undefined) return rowsFromRefs(props.refs, host, reader, labelPath);
    return { rows: result ? rowsFromQuery(result, reader, labelPath) : [], unloadedModels: [] as string[] };
  }, [props.refs, result, host, reader, labelPath]);
  const title = typeof props.title === 'string' ? props.title : undefined;

  return (
    <div style={weightStyle(props.weight)} className="flex min-w-0 flex-col gap-1">
      {title && <div className="text-sm font-semibold">{title}</div>}
      <ResultNotes result={result} unloadedModels={unloadedModels} />
      {rows.length === 0 && !result?.unloadedModel && unloadedModels.length === 0 && <Note>{t('a2ui.empty')}</Note>}
      {rows.length > 0 && <ul className="flex max-h-72 flex-col overflow-auto rounded-md border text-xs">
        {rows.map((row) => (
          <li key={row.key}>
            <button
              type="button"
              disabled={!row.live}
              data-a2ui-row={row.ref ? encodeRef(row.ref) : undefined}
              aria-label={t('a2ui.list.itemLabel', { name: row.label })}
              aria-pressed={activeKey === row.key}
              onClick={() => { setActiveKey(row.key); selectAndFly(row); }}
              className={cn(
                'flex w-full items-center justify-between gap-2 px-2 py-1 text-left hover:bg-accent disabled:opacity-60',
                activeKey === row.key && 'bg-active-surface text-active',
              )}
            >
              <span className="truncate">{row.label}</span>
              <span className="shrink-0 text-2xs text-muted-foreground">{String(row.read('type') ?? '')}</span>
            </button>
          </li>
        ))}
      </ul>}
    </div>
  );
});
