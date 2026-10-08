/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState } from 'react';
import { type SparqlResults, type BindingMapping, type EntityAddress, type Resolution, type LiveEntity } from '@ifc-lite/semantic';
import { useViewerStore } from '@/store';
import { createSelectionAdapter } from '@/sdk/adapters/selection-adapter';
import { resolveResource } from '@/lib/semantic/resolver';
import { useSemanticSession } from '@/lib/semantic/session';
import { identityFromRow } from '@/lib/semantic/resolver-context';
import { liveEntities } from '@/lib/semantic/viewer';
import { useTranslation } from '@/i18n';

interface Props {
  results: SparqlResults; mapping: BindingMapping; revisions: ReadonlyMap<string, string>; scope?: string;
  onError: (error: unknown) => void;
}
const PAGE_SIZE = 50;
/** Analytical rows need no domain projection; IFC identity columns are optional. */
export function SemanticResults({ results, mapping, revisions, scope, onError }: Props) {
  const { t } = useTranslation();
  const statusKeys = { resolved: 'semantic.resultsResolved', ambiguous: 'semantic.resultsAmbiguous', unmatched: 'semantic.resultsUnmatched', unscoped: 'semantic.resultsUnscoped', external: 'semantic.resultsExternal', invalid: 'semantic.resultsInvalid' } as const;
  const [page, setPage] = useState(0);
  const [choices, setChoices] = useState<{ row: number; refs: EntityAddress[] }>();
  useEffect(() => { setPage(0); setChoices(undefined); }, [results]);
  // Selection and mutation revisions make diagnostics responsive to deleted/edited models.
  useViewerStore(state => state.models);
  useViewerStore(state => state.mutationViews);
  useViewerStore(state => state.mutationVersion);
  useSemanticSession(state => state.strategy);
  useSemanticSession(state => state.links);
  useSemanticSession(state => state.identityFields);
  useSemanticSession(state => state.uriConfig);
  const start = Math.min(page * PAGE_SIZE, Math.max(0, Math.floor((results.rows.length - 1) / PAGE_SIZE) * PAGE_SIZE));
  const end = Math.min(start + PAGE_SIZE, results.rows.length);
  const renderedEntities = liveEntities();
  const resolve = (rowIndex: number, entities: readonly LiveEntity[] = renderedEntities): Resolution => {
    const row = results.rows[rowIndex];
    const identity = identityFromRow(row, mapping, useSemanticSession.getState());
    if (!identity) return { status: 'invalid' };
    return resolveResource(identity, entities, revisions, scope);
  };
  const select = (rowIndex: number, chosen?: EntityAddress) => {
    try {
      const resolution = resolve(rowIndex, liveEntities());
      if (chosen && resolution.status === 'resolved' && (chosen.modelId !== resolution.ref.modelId || chosen.expressId !== resolution.ref.expressId)) throw new Error(t('semantic.resultsStale'));
      if (resolution.status === 'resolved') { createSelectionAdapter(useViewerStore).set([resolution.ref]); setChoices(undefined); }
      else if (resolution.status === 'ambiguous') {
        if (!chosen) setChoices({ row: rowIndex, refs: resolution.candidates });
        else if (resolution.candidates.some(ref => ref.modelId === chosen.modelId && ref.expressId === chosen.expressId)) {
          createSelectionAdapter(useViewerStore).set([chosen]); setChoices(undefined);
        } else throw new Error(t('semantic.resultsStale'));
      } else if (chosen) throw new Error(t('semantic.resultsStale'));
    } catch (error) { onError(error); }
  };
  return <section aria-label={t('semantic.resultsTitle')} className="space-y-2">
    <h3 className="font-medium">{t('semantic.resultsTitle')}</h3>
    <div className="flex items-center justify-between gap-2 text-xs">
      <button disabled={start === 0} onClick={() => { setPage(Math.max(0, Math.floor(start / PAGE_SIZE) - 1)); setChoices(undefined); }}>{t('semantic.resultsPrevious')}</button>
      <span>{t('semantic.resultsPage', { start: results.rows.length ? start + 1 : 0, end, count: results.rows.length })}</span>
      <button disabled={end >= results.rows.length} onClick={() => { setPage(Math.floor(start / PAGE_SIZE) + 1); setChoices(undefined); }}>{t('semantic.resultsNext')}</button>
    </div>
    <div className="overflow-auto"><table className="w-full text-xs"><thead><tr>
      {results.columns.map(column => <th key={column} className="p-1 text-left">{column}</th>)}
      <th className="p-1">{t('semantic.resultsStatus')}</th>
    </tr></thead><tbody>{results.rows.slice(start, end).map((row, offset) => {
      const rowIndex = start + offset; const resolution = resolve(rowIndex);
      return <tr key={rowIndex}>
        {results.columns.map(column => {
          const term = row[column];
          return <td key={column} className="max-w-64 break-words border-t p-1" title={term?.datatype ?? term?.type}>
            {term ? <>{term.type === 'bnode' ? '_:' : ''}{term.value}{term['xml:lang'] ? ` @${term['xml:lang']}` : ''}{term.datatype ? <small className="block text-muted-foreground">{term.datatype}</small> : null}</> : <span className="text-muted-foreground">{t('semantic.resultsUnbound')}</span>}
          </td>;
        })}
        <td className="border-t p-1"><button disabled={resolution.status !== 'resolved' && resolution.status !== 'ambiguous'} onClick={() => select(rowIndex)} aria-label={t('semantic.resultsSelect')}>
          {t(statusKeys[resolution.status])}
        </button></td>
      </tr>;
    })}</tbody></table></div>
    {choices && <fieldset className="rounded border p-2"><legend>{t('semantic.resultsCandidates')}</legend>
      {choices.refs.map(ref => <button key={`${ref.modelId}:${ref.expressId}`} className="block text-xs" onClick={() => select(choices.row, ref)}>
        {t('semantic.resultsChoose', { model: useViewerStore.getState().models.get(ref.modelId)?.name ?? ref.modelId, id: ref.expressId })}
      </button>)}
    </fieldset>}
  </section>;
}
