/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Assistant header's placement choice and return target (#6926).
 * Placement is an explicit, persisted preference (`lib/assistant/placement`);
 * the return button appears only while the source the Assistant was opened
 * from is out of sight (side dock, narrow-layout sheet).
 */

import { ArrowLeft, PanelRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { usePanelControls } from '@/hooks/usePanelControls';
import { panelTitleKey } from '@/lib/panels/registry';
import {
  ASSISTANT_PLACEMENTS, isAssistantPlacement, returnTargetHidden, setAssistantPlacement, useAssistantPlacement,
} from '@/lib/assistant/placement';

const PLACEMENT_LABEL = {
  split: 'assistantPlacement.split',
  dock: 'assistantPlacement.dock',
  floating: 'assistantPlacement.floating',
} as const;

export function AssistantPlacementMenu() {
  const { t } = useTranslation();
  const placement = useAssistantPlacement((s) => s.placement);
  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <IconButton label={t('assistantPlacement.menu')} tooltip={`${t('assistantPlacement.menu')}: ${t(PLACEMENT_LABEL[placement])}`} className="h-7 w-7">
        <PanelRight className="h-4 w-4" />
      </IconButton>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="w-56">
      <DropdownMenuLabel className="text-xs">{t('assistantPlacement.menu')}</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={placement} onValueChange={(value) => { if (isAssistantPlacement(value)) setAssistantPlacement(value); }}>
        {ASSISTANT_PLACEMENTS.map((option) => <DropdownMenuRadioItem key={option} value={option} className="min-h-7 text-xs">
          {t(PLACEMENT_LABEL[option])}
        </DropdownMenuRadioItem>)}
      </DropdownMenuRadioGroup>
    </DropdownMenuContent>
  </DropdownMenu>;
}

export function AssistantReturnButton() {
  const { t } = useTranslation();
  const panels = usePanelControls();
  const target = useAssistantPlacement((s) => s.returnTarget);
  const hidden = useViewerStore((s) => target !== null && returnTargetHidden(s, target));
  if (!target || !hidden) return null;
  return <Button size="sm" variant="ghost" className="h-7 min-w-0 gap-1 px-2 text-xs" onClick={() => panels.openInHome(target, 'context')}>
    <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
    <span className="truncate">{t('assistantPlacement.back', { panel: t(panelTitleKey(target)) })}</span>
  </Button>;
}
