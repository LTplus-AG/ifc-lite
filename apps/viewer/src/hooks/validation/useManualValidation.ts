/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * File lifecycle of the Manual validation tab (#6401): new checklist, open
 * a `.checklist.json`, reopen a recent one, save (download) the current
 * one. The checklist itself and its answers live in `manualValidationSlice`;
 * this hook only owns the transient error and the recent list, the same
 * split `useInformationValidation` has for rule sets.
 */

import { useCallback, useState } from 'react';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { parseChecklistText, type ChecklistTemplate } from '@/lib/validation/manual/checklist';
import { exportChecklist, importChecklistFile } from '@/lib/validation/manual/checklist-io-browser';
import {
  addRecentChecklist, loadRecentChecklists, removeRecentChecklist, type RecentChecklist,
} from '@/lib/validation/manual/recent-checklists';

export interface UseManualValidationResult {
  checklist: ChecklistTemplate | null;
  newChecklist: () => void;
  /** Parse a picked file; `ok: false` also lands in `error`. */
  openFromFile: (file: File) => Promise<{ ok: boolean }>;
  loadFromRecent: (entry: RecentChecklist) => void;
  /** Download the current checklist and cache it under "Recent". */
  save: () => void;
  close: () => void;
  recent: RecentChecklist[];
  error: string | null;
}

export function useManualValidation(): UseManualValidationResult {
  const { t } = useTranslation();
  const checklist = useViewerStore((s) => s.manualChecklist);
  const setChecklist = useViewerStore((s) => s.setManualChecklist);
  const newManualChecklist = useViewerStore((s) => s.newManualChecklist);
  const [recent, setRecent] = useState<RecentChecklist[]>(() => loadRecentChecklists());
  const [error, setError] = useState<string | null>(null);

  const recentName = useCallback(
    (template: ChecklistTemplate) => template.name.trim() || t('manualValidation.name.placeholder'),
    [t],
  );

  const newChecklist = useCallback(() => {
    newManualChecklist();
    setError(null);
  }, [newManualChecklist]);

  const openFromFile = useCallback(async (file: File) => {
    const result = await importChecklistFile(file);
    if (!result.ok) {
      setError(t('manualValidation.error.invalidFile', { name: file.name, detail: result.error }));
      return { ok: false };
    }
    setChecklist(result.template);
    setError(null);
    setRecent(addRecentChecklist(recentName(result.template), JSON.stringify(result.template, null, 2)));
    return { ok: true };
  }, [recentName, setChecklist, t]);

  const loadFromRecent = useCallback((entry: RecentChecklist) => {
    const result = parseChecklistText(entry.content);
    if (!result.ok) {
      setError(t('manualValidation.error.corruptRecent', { name: entry.name }));
      setRecent(removeRecentChecklist(entry.name));
      return;
    }
    setChecklist(result.template);
    setError(null);
  }, [setChecklist, t]);

  const save = useCallback(() => {
    if (!checklist) return;
    const text = exportChecklist(checklist);
    setRecent(addRecentChecklist(recentName(checklist), text));
  }, [checklist, recentName]);

  const close = useCallback(() => {
    setChecklist(null);
    setError(null);
  }, [setChecklist]);

  return { checklist, newChecklist, openFromFile, loadFromRecent, save, close, recent, error };
}
