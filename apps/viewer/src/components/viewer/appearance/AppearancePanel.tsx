/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { AppearanceScanPanel } from './AppearanceScanPanel';
import { AppearanceCapturePanel } from './AppearanceCapturePanel';
import { useState } from 'react';
import { useViewerStore } from '@/store';
import type { AppearanceIntent } from '@/lib/appearance/draft-types.js';
import { useReferenceAppearance } from './useReferenceAppearance.js';
import { AppearancePanelView } from './AppearancePanelView.js';
import { useAppearancePanel } from './useAppearancePanel.js';

export function AppearancePanel() {
  const [intent, setIntent] = useState<AppearanceIntent>(() => useViewerStore.getState().appearanceDraft?.intent ?? 'apply');
  const appearance = useAppearancePanel(intent);
  const controls = useReferenceAppearance(appearance, intent === 'reference');
  return <AppearancePanelView {...controls} scan={intent === 'scan' ? <AppearanceScanPanel /> : undefined} capture={intent === 'capture' ? <AppearanceCapturePanel /> : undefined} intent={intent} onIntentChange={next => {
    controls.onDiscard(); setIntent(next);
  }} />;
}
