/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Information validation" (rule-set) lifecycle for `ValidationPanel`
 * (#5138 plan §6): the current `RuleSetFile` + its edit ("authoring" vs.
 * "results") state, running `runRuleSet` against every loaded model, and
 * writing the landed report through the same generalised store slot IDS
 * uses (`setIdsValidationReport` — the slot name is unchanged, only its
 * type; see `idsSlice.ts`). Mirrors `useIDS.runValidation`'s supersession
 * guard (`useValidationEpoch`) so a cancelled/superseded run can never
 * publish a stale or partial report.
 */

import { useCallback, useRef, useState } from 'react';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { resolveTargetModels, runRuleSet, type RuleEngineProgress } from '@ifc-lite/rules';
import type { RuleSetFile } from '@ifc-lite/rules';
import { parseRuleSetFile } from '@ifc-lite/rules';
import { importRuleSetFile, exportRuleSet } from '@/lib/validation/rule-set-io-browser';
import {
  exportRuleSetAsIds, idsVersionsForSchemas, importIdsFileAsRuleSet,
} from '@/lib/validation/rule-set-ids-browser';
import { evaluatorModelsFromState, definedModelTagIdsOf } from '@/lib/model-tags/evaluator-models';
import {
  addRecentRuleSet, loadRecentRuleSets, removeRecentRuleSet, type RecentRuleSet,
} from '@/lib/validation/recent-rule-sets';
import { useValidationEpoch } from './useValidationEpoch';

/** What the last IDS export or import converted, and what it refused and why (#5225). */
export interface IdsInterchangeSummary {
  direction: 'export' | 'import';
  /** Rules exported / specifications imported. */
  converted: number;
  total: number;
  refused: ReadonlyArray<{ name: string; reasons: readonly string[] }>;
  notes: readonly string[];
  /** Import only: IDS checks the imported rules do not make (a dropped `dataType`). */
  dropped?: readonly string[];
}

function blankRuleSet(): RuleSetFile {
  return { version: 1, name: '', rules: [] };
}

export interface UseInformationValidationResult {
  file: RuleSetFile | null;
  setFile: (next: RuleSetFile) => void;
  /** Start authoring a brand new, empty rule set. */
  newRuleSet: () => void;
  /** Parse a picked `.rules.json` File; `ok: false` carries a message to show
   *  (also written to `error`, so a caller that only checks `error` still
   *  sees it). */
  openFromFile: (file: File) => Promise<{ ok: boolean; error?: string }>;
  /** Load a "Recent rule sets" entry by re-parsing its cached content.
   *  Never throws: a corrupt entry (bad JSON, or JSON that no longer parses
   *  as a rule set) is reported through `error` and dropped from the cache
   *  rather than left to fail silently or the next time it is clicked. */
  loadFromRecent: (entry: RecentRuleSet) => void;
  /** Download the current file and cache its content under "Recent". */
  save: () => void;
  /** Download the current file's IDS-expressible rules as `<name>.ids` (#5225). */
  exportIds: () => void;
  /** Convert a picked IDS file's simple specifications into a new rule set (#5225). */
  importIds: (file: File) => Promise<{ ok: boolean; error?: string }>;
  /** The last IDS export/import outcome, until dismissed or superseded. */
  idsSummary: IdsInterchangeSummary | null;
  dismissIdsSummary: () => void;
  /** True while showing the editor again after a report already landed
   *  (plan §6: "Edit rules" returns to authoring, keeping the report until
   *  the next run). */
  editing: boolean;
  setEditing: (editing: boolean) => void;
  run: () => Promise<void>;
  cancel: () => void;
  running: boolean;
  progress: RuleEngineProgress | null;
  error: string | null;
  recentRuleSets: RecentRuleSet[];
}

export function useInformationValidation(): UseInformationValidationResult {
  const { t } = useTranslation();
  const file = useViewerStore((s) => s.validationRuleSetDraft);
  const editing = useViewerStore((s) => s.validationRuleSetEditing);
  const setFileState = useViewerStore((s) => s.setValidationRuleSetDraft);
  const setEditing = useViewerStore((s) => s.setValidationRuleSetEditing);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<RuleEngineProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recentRuleSets, setRecentRuleSets] = useState<RecentRuleSet[]>(() => loadRecentRuleSets());
  const [idsSummary, setIdsSummary] = useState<IdsInterchangeSummary | null>(null);

  const setIdsValidationReport = useViewerStore((s) => s.setIdsValidationReport);
  const abortRef = useRef<AbortController | null>(null);
  const { bump: bumpEpoch, stillWanted } = useValidationEpoch();

  const setFile = useCallback((next: RuleSetFile) => {
    setFileState(next);
    setError(null);
  }, [setFileState]);

  const newRuleSet = useCallback(() => {
    setFile(blankRuleSet());
    setEditing(true);
  }, [setFile]);

  const openFromFile = useCallback(async (pickedFile: File): Promise<{ ok: boolean; error?: string }> => {
    const result = await importRuleSetFile(pickedFile);
    if (!result.ok) {
      setError(result.error);
      return { ok: false, error: result.error };
    }
    setFile(result.file);
    setEditing(true);
    setRecentRuleSets(addRecentRuleSet(result.file.name, JSON.stringify(result.file, null, 2)));
    return { ok: true };
  }, [setFile]);

  const loadFromRecent = useCallback((entry: RecentRuleSet) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(entry.content);
    } catch {
      setError(t('validationPanel.error.corruptRecent', { name: entry.name }));
      setRecentRuleSets(removeRecentRuleSet(entry.name));
      return;
    }
    const result = parseRuleSetFile(parsed);
    if (!result.ok) {
      setError(t('validationPanel.error.corruptRecent', { name: entry.name }));
      setRecentRuleSets(removeRecentRuleSet(entry.name));
      return;
    }
    setFile(result.file);
    setEditing(true);
  }, [setFile, t]);

  const save = useCallback(() => {
    if (!file) return;
    exportRuleSet(file);
    setRecentRuleSets(addRecentRuleSet(file.name, JSON.stringify(file, null, 2)));
  }, [file]);

  const exportIds = useCallback(() => {
    if (!file) return;
    const state = useViewerStore.getState();
    const schemas = [...state.models.values()].map((m) => m.schemaVersion);
    const result = exportRuleSetAsIds(
      file,
      idsVersionsForSchemas(schemas),
      resolveTargetModels(evaluatorModelsFromState(state), file.targets),
    );
    setIdsSummary({
      direction: 'export',
      converted: result.exportedRuleIds.length,
      total: file.rules.length,
      refused: result.refused.map((r) => ({ name: r.ruleName || r.ruleId, reasons: r.reasons })),
      notes: result.notes,
    });
  }, [file]);

  const importIds = useCallback(async (pickedFile: File): Promise<{ ok: boolean; error?: string }> => {
    const outcome = await importIdsFileAsRuleSet(pickedFile);
    if (!outcome.ok) {
      setError(outcome.error);
      return { ok: false, error: outcome.error };
    }
    const { result } = outcome;
    const imported = result.file?.rules.length ?? 0;
    setIdsSummary({
      direction: 'import',
      converted: imported,
      total: imported + result.refused.length,
      refused: result.refused.map((r) => ({ name: r.specificationName, reasons: r.reasons })),
      notes: result.notes,
      dropped: result.droppedChecks,
    });
    if (!result.file) {
      setError(null);
      return { ok: false };
    }
    setFile(result.file);
    setEditing(true);
    return { ok: true };
  }, [setFile]);

  const dismissIdsSummary = useCallback(() => setIdsSummary(null), []);

  const cancel = useCallback(() => {
    bumpEpoch();
    abortRef.current?.abort();
    setRunning(false);
    setProgress(null);
  }, [bumpEpoch]);

  const run = useCallback(async () => {
    if (!file) return;
    const myEpoch = bumpEpoch();
    const controller = new AbortController();
    abortRef.current = controller;

    setRunning(true);
    setProgress(null);
    setError(null);
    try {
      // #5138 PR 7a: `runRuleSet` takes plain `EvaluatorModel[]` +
      // `definedModelTagIds` now (no viewer-shaped `ModelTagState`) — the
      // live store state is turned into that shape here, the one place the
      // adapter (`lib/model-tags/evaluator-models.ts`) is called from.
      const state = useViewerStore.getState();
      const report = await runRuleSet({
        ruleSet: file,
        models: evaluatorModelsFromState(state),
        definedModelTagIds: definedModelTagIdsOf(state),
        signal: controller.signal,
        onProgress: (p) => { if (stillWanted(myEpoch)) setProgress(p); },
      });
      // A cancelled/superseded run must never publish a report — checked
      // AFTER the (possibly long) engine run completes, mirroring
      // `useIDS.runValidation`'s `stillWantedValidation` guard (#2802).
      if (!stillWanted(myEpoch)) return;
      setIdsValidationReport(report);
      setEditing(false);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (!stillWanted(myEpoch)) return;
      // A caught engine exception's own message is arbitrary runtime text
      // (not catalogued, same posture as `idsError`'s plain-string branch —
      // see `resolveValidationTarget.ts`'s `IdsErrorState` doc); only the
      // FALLBACK, shown when there is no such message, is a fixed
      // user-visible string and goes through the catalogue.
      setError(err instanceof Error ? err.message : t('validationPanel.error.validationFailed'));
    } finally {
      if (stillWanted(myEpoch)) {
        setRunning(false);
        setProgress(null);
      }
    }
  }, [file, bumpEpoch, stillWanted, setIdsValidationReport, t]);

  return {
    file, setFile, newRuleSet, openFromFile, loadFromRecent, save,
    exportIds, importIds, idsSummary, dismissIdsSummary,
    editing, setEditing, run, cancel, running, progress, error, recentRuleSets,
  };
}
