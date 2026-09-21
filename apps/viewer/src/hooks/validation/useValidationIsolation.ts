/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Set-level isolation for a `ValidationReport`, generalised over its source
 * (#5138 plan §5/§6: split out of `useIDS.ts`'s "Isolation Actions" section
 * — behaviour unchanged, only the report type widened). Paired with
 * `useValidationColorFocus.ts` (row focus + colour overlay, whose
 * `restoreReportColors`/`setSpecColors`/`buildColors` this needs) by the
 * orchestrating `useValidationResults.ts`.
 *
 * `isolateSetMembers` is new (#5138 plan §6: `IDSResultRows`'s `SetResult`
 * rows isolate their members through this SAME channel the
 * failed/passed/involved buttons use, rather than a second isolate path).
 */

import { useCallback } from 'react';
import { useViewerStore } from '@/store';
import type { SetResult } from '@ifc-lite/ids';
import { resolvePresentationIds } from '@/lib/presentation/resolvePresentationIds';
import type { IDSIsolationScope } from '@/store/slices/idsSlice';
import { useToViewerGlobalId } from './toViewerGlobalId';
import type { ColorTuple } from '../ids/idsColorSystem';

export interface ValidationIsolationApi {
  isolateFailed: () => void;
  isolatePassed: () => void;
  isolateInvolved: (specId?: string) => void;
  isolateSetMembers: (members: SetResult['members']) => void;
  clearIsolation: () => void;
  setActiveSpecification: (specId: string | null) => void;
  setIsolationScope: (scope: IDSIsolationScope) => void;
}

export interface UseValidationIsolationParams {
  isolationScope: IDSIsolationScope;
  activeSpecificationId: string | null;
  buildColors: (specId?: string, bothHighlights?: boolean) => Map<number, ColorTuple>;
  setSpecColors: (specId: string) => void;
  restoreReportColors: () => void;
}

export function useValidationIsolation(params: UseValidationIsolationParams): ValidationIsolationApi {
  const { isolationScope, activeSpecificationId, buildColors, setSpecColors, restoreReportColors } = params;

  const setIdsActiveSpecification = useViewerStore((s) => s.setIdsActiveSpecification);
  const setIdsIsolationScope = useViewerStore((s) => s.setIdsIsolationScope);
  const setIdsIsolateMode = useViewerStore((s) => s.setIdsIsolateMode);
  const setIsolatedEntities = useViewerStore((s) => s.setIsolatedEntities);
  const setPendingColorUpdates = useViewerStore((s) => s.setPendingColorUpdates);
  const idsFailedEntityIds = useViewerStore((s) => s.idsFailedEntityIds);
  const idsPassedEntityIds = useViewerStore((s) => s.idsPassedEntityIds);
  const getFailedEntitiesForSpec = useViewerStore((s) => s.getFailedEntitiesForSpec);
  const getPassedEntitiesForSpec = useViewerStore((s) => s.getPassedEntitiesForSpec);

  const toViewerGlobalId = useToViewerGlobalId();

  const keyToGlobalId = useCallback((key: string): number | undefined => {
    const lastColonIndex = key.lastIndexOf(':');
    const modelId = key.substring(0, lastColonIndex);
    const expressId = parseInt(key.substring(lastColonIndex + 1), 10);
    return toViewerGlobalId(modelId, expressId);
  }, [toViewerGlobalId]);

  const refsToGlobalIds = useCallback(
    (refs: Array<{ modelId: string; expressId: number }>): Set<number> => {
      const ids = new Set<number>();
      for (const { modelId, expressId } of refs) {
        const globalId = toViewerGlobalId(modelId, expressId);
        if (globalId != null) ids.add(globalId);
      }
      return ids;
    },
    [toViewerGlobalId],
  );

  const keySetToGlobalIds = useCallback((keys: Set<string>): Set<number> => {
    const ids = new Set<number>();
    for (const key of keys) {
      const globalId = keyToGlobalId(key);
      if (globalId != null) ids.add(globalId);
    }
    return ids;
  }, [keyToGlobalId]);

  const installSetIsolation = useCallback((ids: Set<number> | null) => {
    const resolver = useViewerStore.getState().cameraCallbacks.resolveHighlightIds;
    setIsolatedEntities(ids === null ? null : new Set(resolvePresentationIds(resolver, [...ids])));
    useViewerStore.getState().setIdsFocusVisibilityOwned(null);
  }, [setIsolatedEntities]);

  const isolateFailed = useCallback(() => {
    if (isolationScope === 'spec') {
      if (!activeSpecificationId) return;
      const ids = refsToGlobalIds(getFailedEntitiesForSpec(activeSpecificationId));
      if (ids.size > 0) {
        installSetIsolation(ids);
        setSpecColors(activeSpecificationId);
        setIdsIsolateMode('failed');
      }
      return;
    }
    const failedIds = keySetToGlobalIds(idsFailedEntityIds);
    if (failedIds.size > 0) {
      installSetIsolation(failedIds);
      setIdsIsolateMode('failed');
    }
  }, [isolationScope, activeSpecificationId, getFailedEntitiesForSpec, refsToGlobalIds, keySetToGlobalIds, idsFailedEntityIds, installSetIsolation, setSpecColors, setIdsIsolateMode]);

  const isolatePassed = useCallback(() => {
    if (isolationScope === 'spec') {
      if (!activeSpecificationId) return;
      const ids = refsToGlobalIds(getPassedEntitiesForSpec(activeSpecificationId));
      if (ids.size > 0) {
        installSetIsolation(ids);
        setSpecColors(activeSpecificationId);
        setIdsIsolateMode('passed');
      }
      return;
    }
    const passedIds = keySetToGlobalIds(idsPassedEntityIds);
    if (passedIds.size > 0) {
      installSetIsolation(passedIds);
      setIdsIsolateMode('passed');
    }
  }, [isolationScope, activeSpecificationId, getPassedEntitiesForSpec, refsToGlobalIds, keySetToGlobalIds, idsPassedEntityIds, installSetIsolation, setSpecColors, setIdsIsolateMode]);

  const isolateInvolved = useCallback((specId?: string) => {
    const targetSpec = specId ?? (isolationScope === 'spec' ? activeSpecificationId : null);
    if (targetSpec) {
      const ids = refsToGlobalIds([
        ...getFailedEntitiesForSpec(targetSpec),
        ...getPassedEntitiesForSpec(targetSpec),
      ]);
      if (ids.size > 0) {
        installSetIsolation(ids);
        setSpecColors(targetSpec);
        setIdsIsolateMode('involved');
      } else {
        installSetIsolation(null);
        restoreReportColors();
        setIdsIsolateMode(null);
      }
      return;
    }
    const ids = keySetToGlobalIds(idsFailedEntityIds);
    for (const globalId of keySetToGlobalIds(idsPassedEntityIds)) ids.add(globalId);
    if (ids.size > 0) {
      installSetIsolation(ids);
      setPendingColorUpdates(buildColors(undefined, true));
      setIdsIsolateMode('involved');
    }
  }, [isolationScope, activeSpecificationId, getFailedEntitiesForSpec, getPassedEntitiesForSpec, refsToGlobalIds, keySetToGlobalIds, idsFailedEntityIds, idsPassedEntityIds, installSetIsolation, setSpecColors, restoreReportColors, setPendingColorUpdates, setIdsIsolateMode, buildColors]);

  /** A `SetResultRow` click (#5138 plan §6) — isolates the group's members
   *  through the SAME shared channel `isolateFailed`/`Passed`/`Involved` use.
   *  Deliberately does not touch `idsIsolateMode`: that state drives the
   *  toolbar buttons' pressed state, and a set-row isolate is neither of
   *  the three set-level actions they represent. */
  const isolateSetMembers = useCallback((members: SetResult['members']) => {
    const ids = refsToGlobalIds(members);
    if (ids.size > 0) installSetIsolation(ids);
  }, [refsToGlobalIds, installSetIsolation]);

  const clearIsolation = useCallback(() => {
    installSetIsolation(null);
    restoreReportColors();
    setIdsIsolateMode(null);
  }, [installSetIsolation, restoreReportColors, setIdsIsolateMode]);

  const setActiveSpecification = useCallback((specId: string | null) => {
    setIdsActiveSpecification(specId);
    if (isolationScope === 'spec') {
      if (specId) isolateInvolved(specId);
      else clearIsolation();
    }
  }, [setIdsActiveSpecification, isolationScope, isolateInvolved, clearIsolation]);

  const setIsolationScope = useCallback((scope: IDSIsolationScope) => {
    setIdsIsolationScope(scope);
    if (scope === 'spec') {
      if (activeSpecificationId) isolateInvolved(activeSpecificationId);
      else clearIsolation();
    } else {
      clearIsolation();
    }
  }, [setIdsIsolationScope, activeSpecificationId, isolateInvolved, clearIsolation]);

  return {
    isolateFailed, isolatePassed, isolateInvolved, isolateSetMembers, clearIsolation,
    setActiveSpecification, setIsolationScope,
  };
}
