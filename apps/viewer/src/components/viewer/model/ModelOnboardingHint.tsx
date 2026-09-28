/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Model workspace's one-time hint (charter #6232, M2 §1.6): while Select
 * is the tool, the HUD's bottom line says how to start drawing and how to
 * leave. The first edit THIS user makes in the workspace retires it for good
 * (per browser), so it never nags someone who already knows.
 *
 * "This user" is read off the undo history: a local edit (a command commit,
 * an inspector write) pushes an undo entry, while a collaborator's edit is
 * applied without one (`collabSlice`'s remote-apply handlers) and can only
 * SHRINK local history. So `mutationVersion`, which every edit bumps, would
 * retire the hint for a user who never drew anything as soon as a peer typed
 * somewhere (#6315 review); growth of the undo depth does not.
 */

import { useEffect, useRef, useState } from 'react';
import { useViewerStore, type ViewerState } from '@/store';
import { useTranslation } from '@/i18n';
import { HudHint, HudItem } from '../../viewport-ui/hud';

const SEEN_KEY = 'ifc-lite:model-hint-seen';

/** Local edits recorded across all models (undo entries). */
function localEditDepth(s: ViewerState): number {
  let depth = 0;
  for (const stack of s.undoStacks.values()) depth += stack.length;
  return depth;
}

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
  const inWorkspace = useViewerStore((s) => s.workspaceMode === 'model');
  const selecting = useViewerStore((s) => s.workspaceMode === 'model' && s.activeTool === 'select');
  const depth = useViewerStore(localEditDepth);
  const lastDepth = useRef(depth);

  useEffect(() => {
    const grew = depth > lastDepth.current;
    lastDepth.current = depth;
    if (seen || !grew || !inWorkspace) return;
    markSeen();
    setSeen(true);
  }, [seen, depth, inWorkspace]);

  if (seen || !selecting) return null;
  return (
    <HudItem region="bottom-center" order={0}>
      <div data-model-onboarding-hint>
        <HudHint>{t('modelWorkspace.hint.onboarding')}</HudHint>
      </div>
    </HudItem>
  );
}
