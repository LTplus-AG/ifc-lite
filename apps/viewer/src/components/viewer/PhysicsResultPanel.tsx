/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Floating panel that summarizes the most recent physics simulation.
 *
 * Shown only after the user has run a what-if simulation from the entity
 * context menu. Stays visible until they dismiss it (or close + re-run,
 * which replaces the contents).
 */

import { useCallback } from 'react';
import { X, RotateCcw, RefreshCw, Bomb } from 'lucide-react';
import { useBim } from '@/sdk/BimProvider';
import { usePhysicsResultStore } from '@/sdk/physics-ui-store';
import type { EntityRef } from '@ifc-lite/sdk';

export function PhysicsResultPanel() {
  const result = usePhysicsResultStore((s) => s.result);
  const removed = usePhysicsResultStore((s) => s.removed);
  const setResult = usePhysicsResultStore((s) => s.set);
  const clear = usePhysicsResultStore((s) => s.clear);
  const bim = useBim();

  const handleClear = useCallback(() => {
    bim.viewer.resetColors();
    clear();
  }, [bim, clear]);

  const handleRerun = useCallback(async () => {
    if (!removed) return;
    try {
      await bim.physics.ready();
    } catch (err) {
      console.error('[Physics] init failed:', err);
      return;
    }
    try {
      const next = await bim.physics.simulate(removed.ref.modelId, {
        remove: [removed.ref.expressId],
      });
      const refsFor = (ids: number[]): EntityRef[] =>
        ids.map((expressId) => ({ modelId: removed.ref.modelId, expressId }));
      bim.viewer.colorizeRgba(refsFor(next.falling), [0.86, 0.15, 0.15, 0.95]);
      bim.viewer.colorizeRgba(refsFor(next.tilted), [0.96, 0.62, 0.04, 0.95]);
      bim.viewer.colorizeRgba(refsFor(next.anchored), [0.20, 0.39, 0.92, 0.45]);
      setResult(next, removed);
    } catch (err) {
      console.error('[Physics] re-run failed:', err);
    }
  }, [bim, removed, setResult]);

  if (!result) return null;

  const total = result.bodies.length;
  const fallingPct = total > 0 ? Math.round((result.falling.length / total) * 100) : 0;

  return (
    <div className="fixed top-16 right-4 z-40 w-72 rounded-lg border border-border bg-popover shadow-lg pointer-events-auto">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <Bomb className="w-4 h-4 text-red-600" />
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium truncate">
            What if removed: {removed ? removed.name || `${removed.ifcType} #${removed.ref.expressId}` : '—'}
          </div>
          {removed && <div className="text-[10px] text-muted-foreground truncate">{removed.ifcType}</div>}
        </div>
        <button
          type="button"
          aria-label="Close physics panel"
          onClick={handleClear}
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="px-3 py-2 space-y-1.5">
        <Row swatch="bg-red-600" label="Falling" count={result.falling.length} />
        <Row swatch="bg-amber-500" label="Tilted" count={result.tilted.length} />
        <Row swatch="bg-blue-500/60" label="Anchored" count={result.anchored.length} />
        <Row swatch="bg-zinc-300 dark:bg-zinc-600" label="Stable" count={result.stable.length} />
        <div className="text-[10px] text-muted-foreground pt-1">
          {total} bodies · {result.joints.length} joints · {fallingPct}% would fall
        </div>
      </div>

      <div className="flex gap-1 px-3 py-2 border-t border-border">
        <button
          type="button"
          onClick={handleRerun}
          disabled={!removed}
          className="flex-1 inline-flex items-center justify-center gap-1.5 text-xs px-2 py-1.5 rounded border border-border hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <RefreshCw className="w-3 h-3" />
          Re-run
        </button>
        <button
          type="button"
          onClick={handleClear}
          className="flex-1 inline-flex items-center justify-center gap-1.5 text-xs px-2 py-1.5 rounded border border-border hover:bg-accent"
        >
          <RotateCcw className="w-3 h-3" />
          Reset
        </button>
      </div>
    </div>
  );
}

function Row({ swatch, label, count }: { swatch: string; label: string; count: number }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className={`w-3 h-3 rounded-sm shrink-0 ${swatch}`} />
      <span className="flex-1">{label}</span>
      <span className="tabular-nums font-medium">{count}</span>
    </div>
  );
}
