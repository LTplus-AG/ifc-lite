/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Model workspace's one-time hint (charter #6232, M2 §1.6): while Select
 * is the tool, the HUD's bottom line says how to start drawing and how to
 * leave. The first edit made in the workspace retires it for good (per
 * browser), so it never nags someone who already knows.
 */

import { useEffect, useRef, useState } from 'react';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { HudHint, HudItem } from '../../viewport-ui/hud';

const SEEN_KEY = 'ifc-lite:model-hint-seen';

function readSeen(): boolean {
  try {
    return globalThis.localStorage?.getItem(SEEN_KEY) === '1';
  } catch (err) {
    console.warn('[modeling] Could not read the onboarding hint flag:', err);
    return false;
  }
}

function markSeen(): void {
  try {
    globalThis.localStorage?.setItem(SEEN_KEY, '1');
  } catch (err) {
    console.warn('[modeling] Could not save the onboarding hint flag:', err);
  }
}

export function ModelOnboardingHint() {
  const { t } = useTranslation();
  const [seen, setSeen] = useState(readSeen);
  const selecting = useViewerStore((s) => s.workspaceMode === 'model' && s.activeTool === 'select');
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const firstVersion = useRef(mutationVersion);

  useEffect(() => {
    if (seen || mutationVersion === firstVersion.current) return;
    markSeen();
    setSeen(true);
  }, [seen, mutationVersion]);

  if (seen || !selecting) return null;
  return (
    <HudItem region="bottom-center" order={0}>
      <div data-model-onboarding-hint>
        <HudHint>{t('modelWorkspace.hint.onboarding')}</HudHint>
      </div>
    </HudItem>
  );
}
