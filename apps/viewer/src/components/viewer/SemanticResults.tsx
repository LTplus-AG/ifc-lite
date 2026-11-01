/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useMemo, useState } from 'react';
import { type SparqlResults, type BindingMapping, type EntityAddress, type Resolution } from '@ifc-lite/semantic';
import { useViewerStore } from '@/store';
import { createSelectionAdapter } from '@/sdk/adapters/selection-adapter';
import { useSemanticSession } from '@/lib/semantic/session';
import { createIndexedIdentityResolver, identityFromRow } from '@/lib/semantic/resolver-context';
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
  const [choices, setChoices] = useState<{ row: number; refs: EntityAddress[]; additive: boolean }>();
  useEffect(() => { setPage(0); setChoices(undefined); }, [results]);
  // Selection and mutation revisions make diagnostics responsive to deleted/edited models.
  const models = useViewerStore(state => state.models);
  const mutationViews = useViewerStore(state => state.mutationViews);
  const legacyStore = useViewerStore(state => state.ifcDataStore);
  const mutationVersion = useViewerStore(state => state.mutationVersion);
  const strategy = useSemanticSession(state => state.strategy);
  const links = useSemanticSession(state => state.links);
  const identityFields = useSemanticSession(state => state.identityFields);
  const uriConfig = useSemanticSession(state => state.uriConfig);
  useViewerStore(state => state.selectedEntityIds);
  useViewerStore(state => state.selectedEntityId);
  const selection = createSelectionAdapter(useViewerStore);
  const selected = selection.get();
  const same = (a: EntityAddress, b: EntityAddress) => a.modelId === b.modelId && a.expressId === b.expressId;
  const isSelected = (ref: EntityAddress) => selected.some(item => same(item, ref));
  const start = Math.min(page * PAGE_SIZE, Math.max(0, Math.floor((results.rows.length - 1) / PAGE_SIZE) * PAGE_SIZE));
  const end = Math.min(start + PAGE_SIZE, results.rows.length);
  const renderedEntities = useMemo(() => liveEntities(), [models, mutationViews, mutationVersion, legacyStore]);
  const settings = useMemo(() => ({ strategy, links, identityFields, uriConfig }), [strategy, links, identityFields, uriConfig]);
  const renderResolver = useMemo(() => createIndexedIdentityResolver({ entities: renderedEntities, revisions, modelScope: scope }, settings), [renderedEntities, revisions, scope, settings]);
  const resolve = (rowIndex: number, resolver = renderResolver): Resolution => {
    const identity = identityFromRow(results.rows[rowIndex], mapping, useSemanticSession.getState());
    return identity ? resolver(identity) : { status: 'invalid' };
  };
  const renderedResolutions = useMemo(() => results.rows.slice(start, end).map(row => {
    const identity = identityFromRow(row, mapping, settings);
    return identity ? renderResolver(identity) : { status: 'invalid' as const };
  }), [results, start, end, mapping, settings, renderResolver]);
  const freshResolver = () => createIndexedIdentityResolver({ entities: liveEntities(), revisions, modelScope: scope }, useSemanticSession.getState());
  const apply = (ref: EntityAddress, additive: boolean) => {
    const current = selection.get();
    selection.set(additive ? current.some(item => same(item, ref)) ? current.filter(item => !same(item, ref)) : [...current, ref] : [ref]);
    setChoices(undefined);
  };
  const selectAll = () => {
    try {
      const resolver = freshResolver();
      const refs: EntityAddress[] = [];
      for (let row = 0; row < results.rows.length; row++) {
        const resolution = resolve(row, resolver);
        if (resolution.status === 'resolved') refs.push(resolution.ref);
      }
      if (refs.length) selection.set(refs);
      setChoices(undefined);
    } catch (error) { onError(error); }
  };
  const select = (rowIndex: number, chosen?: EntityAddress, additive = false) => {
    try {
      const resolution = resolve(rowIndex, freshResolver());
      if (chosen && resolution.status === 'resolved' && (chosen.modelId !== resolution.ref.modelId || chosen.expressId !== resolution.ref.expressId)) throw new Error(t('semantic.resultsStale'));
      if (resolution.status === 'resolved') { apply(resolution.ref, additive); }
      else if (resolution.status === 'ambiguous') {
        if (!chosen) setChoices({ row: rowIndex, refs: resolution.candidates, additive });
        else if (resolution.candidates.some(ref => ref.modelId === chosen.modelId && ref.expressId === chosen.expressId)) {
          apply(chosen, additive);
        } else throw new Error(t('semantic.resultsStale'));
      } else if (chosen) throw new Error(t('semantic.resultsStale'));
    } catch (error) { onError(error); }
  };
  return <section aria-label={t('semantic.resultsTitle')} className="space-y-2">
    <h3 className="font-medium">{t('semantic.resultsTitle')}</h3>
    <div className="flex flex-wrap gap-2 text-xs">
      <button disabled={!results.rows.length} onClick={selectAll}>{t('semantic.resultsSelectAll')}</button>
      <button disabled={!selected.length} onClick={() => { selection.set([]); setChoices(undefined); }}>{t('semantic.resultsClear')}</button>
    </div>
    <p className="text-xs text-muted-foreground">{t('semantic.resultsSelectionHelp')}</p>
    <div className="flex items-center justify-between gap-2 text-xs">
      <button disabled={start === 0} onClick={() => { setPage(Math.max(0, Math.floor(start / PAGE_SIZE) - 1)); setChoices(undefined); }}>{t('semantic.resultsPrevious')}</button>
      <span>{t('semantic.resultsPage', { start: results.rows.length ? start + 1 : 0, end, count: results.rows.length })}</span>
      <button disabled={end >= results.rows.length} onClick={() => { setPage(Math.floor(start / PAGE_SIZE) + 1); setChoices(undefined); }}>{t('semantic.resultsNext')}</button>
    </div>
    <div className="overflow-auto"><table className="w-full text-xs"><thead><tr>
      <th className="p-1">{t('semantic.resultsSelection')}</th>
      {results.columns.map(column => <th key={column} className="p-1 text-left">{column}</th>)}
      <th className="p-1">{t('semantic.resultsStatus')}</th>
    </tr></thead><tbody>{results.rows.slice(start, end).map((row, offset) => {
      const rowIndex = start + offset; const resolution = renderedResolutions[offset];
      return <tr key={rowIndex}>
        <td className="border-t p-1"><input type="checkbox" aria-label={t('semantic.resultsToggle', { row: rowIndex + 1 })}
          disabled={resolution.status !== 'resolved' && resolution.status !== 'ambiguous'} checked={resolution.status === 'resolved' ? isSelected(resolution.ref) : resolution.status === 'ambiguous' && resolution.candidates.some(isSelected)}
          onChange={() => select(rowIndex, undefined, true)} /></td>
        {results.columns.map(column => {
          const term = row[column];
          return <td key={column} className="max-w-64 break-words border-t p-1" title={term?.datatype ?? term?.type}>
            {term ? <>{term.type === 'bnode' ? '_:' : ''}{term.value}{term['xml:lang'] ? ` @${term['xml:lang']}` : ''}{term.datatype ? <small className="block text-muted-foreground">{term.datatype}</small> : null}</> : <span className="text-muted-foreground">{t('semantic.resultsUnbound')}</span>}
          </td>;
        })}
        <td className="border-t p-1"><button disabled={resolution.status !== 'resolved' && resolution.status !== 'ambiguous'} onClick={event => select(rowIndex, undefined, event.ctrlKey || event.metaKey)} aria-label={t('semantic.resultsSelect')}>
          {t(statusKeys[resolution.status])}
        </button></td>
      </tr>;
    })}</tbody></table></div>
    {choices && <fieldset className="rounded border p-2"><legend>{t('semantic.resultsCandidates')}</legend>
      {choices.refs.map(ref => <button key={`${ref.modelId}:${ref.expressId}`} className="block text-xs" aria-pressed={isSelected(ref)} onClick={() => select(choices.row, ref, choices.additive)}>
        {t('semantic.resultsChoose', { model: useViewerStore.getState().models.get(ref.modelId)?.name ?? ref.modelId, id: ref.expressId })}
      </button>)}
    </fieldset>}
  </section>;
}
