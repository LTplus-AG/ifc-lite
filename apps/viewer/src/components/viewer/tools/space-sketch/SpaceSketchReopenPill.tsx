/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The collapsed Space Sketch affordance. Shown in place of the full panel when
 * the user minimizes it (so the model + live ghost preview are unobstructed);
 * clicking it restores the panel. The draft sessions + 3D preview stay live
 * underneath the whole time - only the panel chrome is swapped out.
 */

import { Layers, ChevronDown } from 'lucide-react';

interface SpaceSketchReopenPillProps {
  /** Pending draft rooms across ALL storeys, so the user knows how much work
   *  is still waiting on a confirm while the panel is collapsed. */
  pendingCount: number;
  onReopen: () => void;
}

export function SpaceSketchReopenPill({ pendingCount, onReopen }: SpaceSketchReopenPillProps) {
  return (
    <div className="absolute left-1/2 top-4 z-30 -translate-x-1/2 pointer-events-auto">
      <button
        onClick={onReopen}
        className="flex items-center gap-2 rounded-full border bg-background/95 px-3 py-1.5 text-xs font-medium shadow-lg backdrop-blur hover:bg-muted"
        title="Reopen the Space Sketch panel"
      >
        <Layers className="h-3.5 w-3.5 text-muted-foreground" />
        <span>Space Sketch</span>
        {pendingCount > 0 && (
          <span className="tabular-nums text-emerald-600 dark:text-emerald-400">
            {pendingCount} to confirm
          </span>
        )}
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
      </button>
    </div>
  );
}
