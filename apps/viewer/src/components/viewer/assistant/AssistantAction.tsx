/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createContext, useContext, type ReactNode } from 'react';
import { Sparkles } from 'lucide-react';
import { IconButton } from '@/components/ui/icon-button';
import { useTranslation, type TranslationKey } from '@/i18n';
import { usePanelControls } from '@/hooks/usePanelControls';
import { useViewerStore } from '@/store';
import { useValidationSourceChoice } from '@/lib/validation/validation-source-choice';
import { captureEvidence, type AssistantSource } from '@/lib/assistant/evidence';
import { panelSource } from '@/lib/assistant/adapters/registry';
import { replaceEvidence } from '@/lib/assistant/conversation';
import type { WorkspacePanelId } from '@/lib/panels/registry';

const PanelContext = createContext<WorkspacePanelId | null>(null);
/** Supplies the hosting panel id; the adapter register decides which source it discusses. */
export function AssistantSourceContext({ panel, children }: { panel: WorkspacePanelId; children: ReactNode }) {
  return <PanelContext.Provider value={panel}>{children}</PanelContext.Provider>;
}

/**
 * Discuss with AI for the panel's current source, or for an explicit `source`
 * when a panel hosts a second one (Flow's last run beside its graph).
 */
export function AssistantAction({ source: explicit, labelKey = 'assistant.explain' }: { source?: AssistantSource; labelKey?: TranslationKey } = {}) {
  const panel = useContext(PanelContext);
  const { t } = useTranslation();
  const panels = usePanelControls();
  // Subscribed so a Data validation side switch re-resolves the panel's subject.
  useValidationSourceChoice(s => s.choice);
  const source = useViewerStore(s => explicit ?? panelSource(panel, s));
  if (!source) return null;
  return <IconButton label={t(labelKey)} className="h-7 w-7" onClick={() => {
    replaceEvidence(captureEvidence(source));
    panels.openInHome('assistant');
  }}><Sparkles className="h-4 w-4" /></IconButton>;
}
