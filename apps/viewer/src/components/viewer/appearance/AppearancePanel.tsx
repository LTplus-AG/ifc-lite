/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { AppearanceAssignments } from './AppearanceAssignments.js';
import { useAppearanceAssignments } from './useAppearanceAssignments.js';
import { AppearanceScanPanel } from './AppearanceScanPanel';
import { AppearanceCapturePanel } from './AppearanceCapturePanel';
import { useEffect, useRef, useState } from 'react';
import { useViewerStore } from '@/store';
import type { AppearanceIntent } from '@/lib/appearance/draft-types.js';
import { useReferenceAppearance } from './useReferenceAppearance.js';
import { AppearancePanelView } from './AppearancePanelView.js';
import { useAppearancePanel } from './useAppearancePanel.js';

export function AppearancePanel() {
  const entry = useViewerStore(state => state.appearanceReferenceEntry);
  const handledEntry = useRef<string | null>(null);
  const [intent, setIntent] = useState<AppearanceIntent>(() => useViewerStore.getState().appearanceReferenceEntry ? 'reference' : useViewerStore.getState().appearanceDraft?.intent ?? 'apply');
  const hasAssignments = useViewerStore(state => !!state.appearanceAssignments?.assignments.length);
  const appearance = useAppearancePanel(intent, hasAssignments);
  const assignments = useAppearanceAssignments(appearance, intent === 'apply');
  const controls = useReferenceAppearance(appearance, intent === 'reference');
  useEffect(() => {
    if (!entry || handledEntry.current === entry.id) return;
    if (intent !== 'reference') { controls.onDiscard(); assignments.cancel(); setIntent('reference'); return; }
    handledEntry.current = entry.id;
    controls.onDiscard(); assignments.cancel();
    setIntent('reference');
    if (entry.editReferenceId) controls.onEditReference?.(entry.editReferenceId);
    else if (entry.settings) appearance.onSettingsChange(entry.settings);
    useViewerStore.getState().consumeAppearanceReferenceEntry(entry.id);
  }, [entry, intent, controls, assignments, appearance]);
  const coordinated = intent === 'apply' && hasAssignments;
  const combined = coordinated ? { ...controls, status: assignments.status, statusMessage: assignments.notice,
    unavailableReason: assignments.blockedReason,
    affectedCount: assignments.affectedCount, convertedObjects: [], excludedCount: 0, exclusions: [],
    canApply: assignments.status === 'ready' && !assignments.original && !assignments.blockedReason, canDiscard: assignments.hasPreview || assignments.busy,
    hasPreview: assignments.hasPreview, assignmentTargetModelIds: assignments.targetModelIds,
    showingOriginal: assignments.original, onCompareChange: assignments.compare,
    onApply: () => { void assignments.apply(); }, onDiscard: assignments.cancel, assignmentMode: true } : controls;
  return <AppearancePanelView {...combined} renderAssignments={intent === 'apply' ? valid => <AppearanceAssignments controller={assignments} base={appearance} formValid={valid} /> : undefined} scan={intent === 'scan' ? <AppearanceScanPanel /> : undefined} capture={intent === 'capture' ? <AppearanceCapturePanel /> : undefined} intent={intent} onIntentChange={next => {
    controls.onDiscard(); assignments.cancel(); setIntent(next);
  }} />;
}
