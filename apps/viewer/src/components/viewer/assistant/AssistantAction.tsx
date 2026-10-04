/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createContext, useContext, type ReactNode } from 'react';
import { Sparkles } from 'lucide-react';
import { IconButton } from '@/components/ui/icon-button';
import { useTranslation } from '@/i18n';
import { usePanelControls } from '@/hooks/usePanelControls';
import { useViewerStore } from '@/store';
import { useValidationSourceChoice } from '@/lib/validation/validation-source-choice';
import { captureEvidence, type AssistantSource } from '@/lib/assistant/evidence';
import { isAssistantSource } from '@/lib/assistant/sources';
import { replaceEvidence } from '@/lib/assistant/conversation';
import type { WorkspacePanelId } from '@/lib/panels/registry';

const SourceContext = createContext<AssistantSource | null>(null);
export function AssistantSourceContext({ panel, children }: { panel: WorkspacePanelId; children: ReactNode }) {
  const source = isAssistantSource(panel) ? panel : null;
  return <SourceContext.Provider value={source}>{children}</SourceContext.Provider>;
}
export function AssistantAction() {
  const source = useContext(SourceContext);
  const { t } = useTranslation();
  const panels = usePanelControls();
  const validationChoice = useValidationSourceChoice(s => s.choice);
  const validationKind = useViewerStore(s => s.idsValidationReport?.source.kind);
  if (!source || (source === 'validation' && validationChoice !== null && validationChoice !== validationKind)) return null;
  return <IconButton label={t('assistant.explain')} className="h-7 w-7" onClick={() => {
    replaceEvidence(captureEvidence(source));
    panels.openInHome('assistant');
  }}><Sparkles className="h-4 w-4" /></IconButton>;
}
