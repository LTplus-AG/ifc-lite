/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Exact invocation ownership for impact links (#7307). No findings are rerun
 * and no BCF component is resolved to a model by guessing its GlobalId. */
import { useViewerStore, type ViewerState } from '@/store';
import { resolveGlobalId } from '@/lib/actions/resolve-global-id';
import { setValidationSourceChoice } from '@/lib/validation/validation-source-choice';
import { selectChangedEntity } from '@/lib/changes/select-changed-entity';
import { compareImpactOf } from './compare-analysis-state';
import { comparisonNavigationIsCurrent } from './comparison-navigation-lease';
import type { ChangedElementRef, CompareImpact, ImpactRow } from './impact';

export interface ImpactNavigation {
  canOpen(row: ImpactRow): boolean;
  open(row: ImpactRow): boolean;
  canSelect(row: ImpactRow, changed: ChangedElementRef): boolean;
  select(row: ImpactRow, changed: ChangedElementRef): boolean;
}

export function captureImpactNavigation(captured: ViewerState, impact: CompareImpact): ImpactNavigation {
  const comparison = captured.compareResult;
  const source = (state: ViewerState, row: ImpactRow): object | null | undefined => {
    switch (row.kind) {
      case 'clash': return state.clashResult;
      case 'validation': return state.idsValidationReport;
      case 'list': return state.activeListId === row.listId ? state.listResult : null;
      case 'bcf': return state.bcfProject?.topics.get(row.topicGuid);
    }
  };
  const sourcePins = new Map(impact.rows.map(row => [row, source(captured, row)]));
  const listDefinition = captured.listDefinitions.find(def => def.id === captured.activeListId);
  const current = (row: ImpactRow, verifyRow = false): ViewerState | null => {
    const state = useViewerStore.getState();
    if (!comparison || !impact.rows.includes(row) || state.compareResult !== comparison
      || comparison.mutationVersion === undefined || comparison.mutationVersion !== state.mutationVersion
      || state.mutationVersion !== captured.mutationVersion
      || !comparisonNavigationIsCurrent(comparison, state)
      || (row.kind === 'clash' && state.clashRawResult !== captured.clashRawResult)
      || (row.kind === 'validation' && state.validationSource !== captured.validationSource)
      || source(state, row) !== sourcePins.get(row) || !sourcePins.get(row)
      || (row.kind === 'list' && state.listDefinitions.find(def => def.id === row.listId) !== listDefinition)) return null;
    // Source objects can contain mutable topic maps. Check the exact native
    // row again at invocation, rather than trusting a displayed title/id.
    const now = verifyRow ? compareImpactOf(state) : impact;
    if (!now || (verifyRow && !now.rows.some(candidate => JSON.stringify(candidate) === JSON.stringify(row)))) return null;
    if (row.kind !== 'list' && now.sources[row.kind] !== 'available') return null;
    return state;
  };
  const target = (row: ImpactRow, changed: ChangedElementRef, verifyRow = false) => {
    const state = current(row, verifyRow);
    const members = row.kind === 'validation' ? [row.changed] : row.changed;
    if (!state || !members.includes(changed) || !comparison) return null;
    const modelId = changed.side === 'base' ? comparison.baseModelId : comparison.headModelId;
    // Pin the native diff ref, then confirm its current canonical Root identity.
    // A reused GlobalId at another express id must not revive the old row.
    const refs = comparison.diff.entries.flatMap(entry => {
      const element = changed.side === 'base' ? entry.base : entry.head;
      return element && element.ref.modelId === modelId
        && (comparison.comparedStores?.get(modelId) ?? captured.models.get(modelId)?.ifcDataStore)
          ?.entities.getGlobalId(element.ref.localId) === changed.globalId ? [element.ref] : [];
    });
    const resolved = resolveGlobalId(state, { modelId, globalId: changed.globalId });
    return refs.length === 1 && typeof resolved === 'object' && resolved.expressId === refs[0].localId ? resolved : null;
  };
  return {
    canOpen: row => !!current(row) && (row.kind !== 'validation' || !!target(row, row.changed)),
    open: row => {
      const state = current(row, true);
      if (!state) return false;
      switch (row.kind) {
        case 'clash': state.setClashSelectedId(row.clashId); break;
        case 'validation': {
          const ref = target(row, row.changed, true);
          if (!ref || !selectChangedEntity(ref.modelId, ref.expressId)) return false;
          setValidationSourceChoice(state.validationSource === 'rules' ? 'rules' : 'ids');
          state.setIdsActiveSpecification(row.specificationId);
          state.setIdsActiveEntity(ref);
          break;
        }
        case 'list': break; // Exact current aggregate, no invented row selection.
        case 'bcf': state.setActiveTopic(row.topicGuid); break;
      }
      state.openPanelInHome(row.kind === 'list' ? 'lists' : row.kind);
      return true;
    },
    canSelect: (row, changed) => !!target(row, changed),
    select: (row, changed) => {
      const ref = target(row, changed, true);
      return !!ref && selectChangedEntity(ref.modelId, ref.expressId);
    },
  };
}
