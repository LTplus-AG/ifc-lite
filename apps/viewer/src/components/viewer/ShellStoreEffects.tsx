/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useSearchIndex } from '@/hooks/useSearchIndex';
import { useUnexportedChangesGuard } from '@/hooks/useUnexportedChanges';
import { useOverlayCompositor } from './schedule/useOverlayCompositor';
import { useEffect } from 'react';
import { LiveViewerScope, useViewerStore } from '@/store';
import { startActivityRecorders } from '@/lib/activity/activity-recorders';

/**
 * Session-wide effects (#6232 perf), mounted once and drawing nothing, so a
 * geometry update or an edit re-renders these components alone. Called from
 * `ViewerLayout` itself, their subscriptions re-rendered the entire viewer
 * shell on every mutation. The search index reads the settled state; the
 * effects in `LiveSessionEffects` follow an edit in its own task.
 */
export function ShellStoreEffects() {
  useSearchIndex();
  useEffect(() => startActivityRecorders(useViewerStore), []); // the activity tray's job journal (#6925)
  return <LiveViewerScope><LiveSessionEffects /></LiveViewerScope>;
}

/** Effects that follow an edit in its own task, not the settled panels (#10535). */
function LiveSessionEffects(): null {
  // Leaving the page with unexported edits asks first (#5604), even while an edit settles.
  useUnexportedChangesGuard();
  // THE writer from the overlay-layer registry into the renderer's legacy
  // hiddenEntities / pendingColorUpdates channels. Mounted once, here, for the
  // whole session: a second instance would keep its own ownership map and
  // double-write. Layer owners (4D animation, charts, …) only register layers.
  useOverlayCompositor();
  return null;
}
