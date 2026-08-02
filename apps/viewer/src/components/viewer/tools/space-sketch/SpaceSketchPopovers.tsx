/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The Space Sketch disclosure popovers — kept out of the default panel flow:
 *  Options (set-once settings) and Help (the full gesture legend). */

import type { BoundaryMode } from '@ifc-lite/create';

export interface OptionsPopoverProps {
  boundaryMode: BoundaryMode;
  onBoundaryMode: (m: BoundaryMode) => void;
  /** Whether this derive carried wall thickness — without it only `center` works. */
  hasWallData: boolean;
  snapDelta: { from: number; to: number } | null;
  usedTol: number;
  /** The weld-tolerance control is disabled until a storey is derived. */
  snapDisabled: boolean;
  onSnap: (tol: number | null) => void;
  snapTol: number | null;
  showBuilding: boolean;
  onToggleBuilding: () => void;
  showDiagnostics: boolean;
  onToggleDiagnostics: () => void;
}

export function OptionsPopover(props: OptionsPopoverProps) {
  const {
    boundaryMode, onBoundaryMode, hasWallData, snapDelta, usedTol, snapDisabled,
    onSnap, snapTol, showBuilding, onToggleBuilding, showDiagnostics, onToggleDiagnostics,
  } = props;
  return (
    <div className="absolute right-3 top-12 z-20 w-64 space-y-3 rounded-lg border bg-popover p-3 text-[11px] text-muted-foreground shadow-xl">
      <div className="space-y-1.5">
        <div className="font-medium text-foreground">Boundary</div>
        <div className="inline-flex rounded-md border p-0.5">
          {(['center', 'inner', 'outer'] as BoundaryMode[]).map((m) => {
            const noWallData = !hasWallData && m !== 'center';
            return (
              <button key={m}
                className={`rounded px-2 py-0.5 capitalize transition-colors disabled:opacity-40 ${boundaryMode === m ? 'bg-primary text-primary-foreground' : 'hover:text-foreground'}`}
                onClick={() => onBoundaryMode(m)} disabled={noWallData}
                title={noWallData ? 'No wall data on this derive — only the centreline is available' : m === 'center' ? 'Wall centreline' : m === 'inner' ? 'Inner (net) face' : 'Outer (gross) face'}>{m}</button>
            );
          })}
        </div>
      </div>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="font-medium text-foreground" title="How close two wall-rectangle corners must be to be welded into one when deriving rooms">Weld tolerance</span>
          {snapDelta && (
            <span className={`tabular-nums ${snapDelta.to === 0 ? 'text-red-500' : snapDelta.to < snapDelta.from ? 'text-amber-500' : 'text-emerald-500'}`}
              title="Rooms before → after">{snapDelta.from} → {snapDelta.to}</span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <input type="range" min={0.05} max={1} step={0.05} value={usedTol} className="flex-1 accent-primary"
            disabled={snapDisabled} onChange={(e) => onSnap(Number(e.target.value))} />
          <input type="number" min={0.05} max={1} step={0.05} value={usedTol} aria-label="Weld tolerance (metres)"
            className="w-12 rounded border bg-background px-1 py-0.5 tabular-nums disabled:opacity-40"
            disabled={snapDisabled}
            onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v) && v > 0) onSnap(Math.min(1, Math.max(0.05, v))); }} />
          <button className="rounded px-1 hover:text-foreground disabled:opacity-40" onClick={() => onSnap(null)}
            disabled={snapDisabled}
            title={snapTol == null ? 'Default (5 cm)' : 'Reset to the 5 cm default'}>{snapTol == null ? 'auto' : 'reset'}</button>
        </div>
      </div>
      <label className="flex cursor-pointer items-center justify-between">
        <span className="text-foreground">Show building underlay</span>
        <input type="checkbox" className="accent-primary" checked={showBuilding} onChange={onToggleBuilding} />
      </label>
      <label className="flex cursor-pointer items-center justify-between">
        <span className="text-foreground">Leak diagnostics</span>
        <input type="checkbox" className="accent-primary" checked={showDiagnostics} disabled={!hasWallData} onChange={onToggleDiagnostics} />
      </label>
    </div>
  );
}

const HELP_ROWS: [string, string][] = [
  ['Drag a node', 'move it (snaps; Shift = straight)'],
  ['Click a wall, then another', 'split the room between them'],
  ['Click empty space', 'draw a room (Enter / dbl-click closes)'],
  ['⌥/Ctrl/right-click a node', 'remove it (cleans up orphans)'],
  ['⌥/Ctrl/right-click a wall', 'merge rooms / remove & clean up'],
  ['Shift-drag / middle-drag', 'pan · scroll = zoom'],
];

export function HelpPopover() {
  return (
    <div className="absolute right-3 top-12 z-20 w-72 space-y-1.5 rounded-lg border bg-popover p-3 text-[11px] shadow-xl">
      <div className="mb-1 font-medium text-foreground">One tool — actions follow the cursor:</div>
      {HELP_ROWS.map(([k, v]) => (
        <div key={k} className="flex gap-2">
          <span className="shrink-0 font-medium text-foreground">{k}</span>
          <span className="text-muted-foreground">— {v}</span>
        </div>
      ))}
    </div>
  );
}
