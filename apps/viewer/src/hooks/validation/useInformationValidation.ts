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
import { runRuleSet, type RuleEngineProgress } from '@/lib/validation/rule-engine';
import type { RuleSetFile } from '@/lib/validation/rule-set';
import { importRuleSetFile, exportRuleSet } from '@/lib/validation/rule-set-io';
import { addRecentRuleSet, loadRecentRuleSets, type RecentRuleSet } from '@/lib/validation/recent-rule-sets';
import { useValidationEpoch } from './useValidationEpoch';

function blankRuleSet(): RuleSetFile {
  return { version: 1, name: '', rules: [] };
}

export interface UseInformationValidationResult {
  file: RuleSetFile | null;
  setFile: (next: RuleSetFile) => void;
  /** Start authoring a brand new, empty rule set. */
  newRuleSet: () => void;
  /** Parse a picked `.rules.json` File; `ok: false` carries a message to show. */
  openFromFile: (file: File) => Promise<{ ok: boolean; error?: string }>;
  /** Download the current file and cache its content under "Recent". */
  save: () => void;
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
  const [file, setFileState] = useState<RuleSetFile | null>(null);
  const [editing, setEditing] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<RuleEngineProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recentRuleSets, setRecentRuleSets] = useState<RecentRuleSet[]>(() => loadRecentRuleSets());

  const setIdsValidationReport = useViewerStore((s) => s.setIdsValidationReport);
  const abortRef = useRef<AbortController | null>(null);
  const { bump: bumpEpoch, stillWanted } = useValidationEpoch();

  const setFile = useCallback((next: RuleSetFile) => {
    setFileState(next);
    setError(null);
  }, []);

  const newRuleSet = useCallback(() => {
    setFile(blankRuleSet());
    setEditing(true);
  }, [setFile]);

  const openFromFile = useCallback(async (pickedFile: File): Promise<{ ok: boolean; error?: string }> => {
    const result = await importRuleSetFile(pickedFile);
    if (!result.ok) return { ok: false, error: result.error };
    setFile(result.file);
    setEditing(true);
    setRecentRuleSets(addRecentRuleSet(result.file.name, JSON.stringify(result.file, null, 2)));
    return { ok: true };
  }, [setFile]);

  const save = useCallback(() => {
    if (!file) return;
    exportRuleSet(file);
    setRecentRuleSets(addRecentRuleSet(file.name, JSON.stringify(file, null, 2)));
  }, [file]);

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
      const report = await runRuleSet({
        ruleSet: file,
        // `ModelTagState` is structural — the live store state already
        // carries `models`/`modelTags`/`modelTagAssignments`/`mutationViews`.
        models: useViewerStore.getState(),
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
      setError(err instanceof Error ? err.message : 'Validation failed');
    } finally {
      if (stillWanted(myEpoch)) {
        setRunning(false);
        setProgress(null);
      }
    }
  }, [file, bumpEpoch, stillWanted, setIdsValidationReport]);

  return {
    file, setFile, newRuleSet, openFromFile, save,
    editing, setEditing, run, cancel, running, progress, error, recentRuleSets,
  };
}
