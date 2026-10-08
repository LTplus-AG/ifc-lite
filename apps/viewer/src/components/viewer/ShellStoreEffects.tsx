/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useSearchIndex } from '@/hooks/useSearchIndex';
import { useUnexportedChangesGuard } from '@/hooks/useUnexportedChanges';
import { useEffect } from 'react';
import { useViewerStore } from '@/store';
import { startActivityRecorders } from '@/lib/activity/activity-recorders';

/**
 * Session-wide effects that read `models` / `mutationVersion` (#6232 perf).
 *
 * Mounted as a leaf that renders nothing, so a geometry update or an edit
 * re-renders this component alone. Called from `ViewerLayout` itself, their
 * subscriptions re-rendered the entire viewer shell on every mutation.
 */
export function ShellStoreEffects(): null {
  useSearchIndex();
  useUnexportedChangesGuard(); // leaving the page with unexported edits asks first (#5604)
  useEffect(() => startActivityRecorders(useViewerStore), []); // the activity tray's job journal (#6925)
  return null;
}
