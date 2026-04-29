/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * PhysicsPanel — right-side UI for rigid-body what-if simulations.
 *
 * Lifecycle:
 * 1. User selects an entity in the viewport, then either clicks the
 *    "Simulate removal" button here or uses the right-click menu shortcut.
 * 2. Simulation runs through `bim.physics.simulate(modelId, options)`,
 *    which yields to the event loop so the UI stays responsive.
 * 3. Falling/tilted/anchored bodies get colorized in the 3D view; the
 *    panel summarizes counts, surfaces the per-body details, and exposes
 *    Re-run / Reset controls.
 *
 * Settings (duration, fall threshold, tilt threshold, adjacency tolerance,
 * collider strategy) live in the viewer store so they survive panel close
 * and round-trip across tabs sharing the SDK transport.
 */

import { useCallback, useMemo, useState } from 'react';
import {
  Bomb,
  Pause,
  Play,
  Repeat,
  RefreshCw,
  RotateCcw,
  Settings,
  Target,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useViewerStore, resolveEntityRef } from '@/store';
import { useBim } from '@/sdk/BimProvider';
import { toast } from '@/components/ui/toast';
import type {
  EntityRef,
  PhysicsColliderStrategy,
  PhysicsSimulateOptions,
  PhysicsSimulationResult,
} from '@ifc-lite/sdk';
import type { PhysicsPanelSettings, PhysicsPlaybackState } from '@/store/slices/physicsSlice';

interface PhysicsPanelProps {
  onClose: () => void;
}

export function PhysicsPanel({ onClose }: PhysicsPanelProps) {
  const bim = useBim();

  const result = useViewerStore((s) => s.physicsResult);
  const removed = useViewerStore((s) => s.physicsRemoved);
  const running = useViewerStore((s) => s.physicsRunning);
  const settings = useViewerStore((s) => s.physicsSettings);
  const playback = useViewerStore((s) => s.physicsPlayback);
  const setRunning = useViewerStore((s) => s.setPhysicsRunning);
  const setResult = useViewerStore((s) => s.setPhysicsResult);
  const clearResult = useViewerStore((s) => s.clearPhysicsResult);
  const updateSettings = useViewerStore((s) => s.updatePhysicsSettings);
  const setPlayback = useViewerStore((s) => s.setPhysicsPlayback);

  const selectedEntity = useViewerStore((s) => s.selectedEntity);
  const selectedEntityId = useViewerStore((s) => s.selectedEntityId);
  const ifcDataStore = useViewerStore((s) => s.ifcDataStore);
  const models = useViewerStore((s) => s.models);

  const [showSettings, setShowSettings] = useState(false);

  /** EntityRef + display fields for whichever entity is currently selected. */
  const selectedTarget = useMemo(() => {
    const ref =
      selectedEntity ??
      (selectedEntityId !== null ? resolveEntityRef(selectedEntityId) : null);
    if (!ref) return null;
    const model = models.get(ref.modelId);
    const dataStore = model?.ifcDataStore ?? ifcDataStore;
    if (!dataStore) {
      return { ref, name: '', ifcType: '' };
    }
    return {
      ref,
      name: dataStore.entities.getName(ref.expressId) || '',
      ifcType: dataStore.entities.getTypeName(ref.expressId) || '',
    };
  }, [selectedEntity, selectedEntityId, models, ifcDataStore]);

  const applyColorize = useCallback(
    (modelId: string, falling: number[], tilted: number[], anchored: number[]) => {
      const refsFor = (ids: number[]): EntityRef[] =>
        ids.map((expressId) => ({ modelId, expressId }));
      bim.viewer.colorizeRgba(refsFor(falling), [0.86, 0.15, 0.15, 0.95]);
      bim.viewer.colorizeRgba(refsFor(tilted), [0.96, 0.62, 0.04, 0.95]);
      bim.viewer.colorizeRgba(refsFor(anchored), [0.20, 0.39, 0.92, 0.45]);
    },
    [bim],
  );

  const runSimulation = useCallback(
    async (target: NonNullable<typeof selectedTarget> | typeof removed) => {
      if (!target) return;
      setRunning(true);
      try {
        await bim.physics.ready();
      } catch (err) {
        console.error('[Physics] init failed:', err);
        toast.error('Physics engine failed to load');
        setRunning(false);
        return;
      }
      const options: PhysicsSimulateOptions = {
        remove: [target.ref.expressId],
        durationSeconds: settings.durationSeconds,
        fallThreshold: settings.fallThreshold,
        tiltThreshold: settings.tiltThreshold,
        adjacencyTolerance: settings.adjacencyTolerance,
        colliderStrategy: settings.colliderStrategy,
      };
      try {
        const next = await bim.physics.simulate(target.ref.modelId, options);
        if (next.bodies.length === 0) {
          toast.info('No geometry loaded — physics needs processed meshes');
          setRunning(false);
          return;
        }
        applyColorize(target.ref.modelId, next.falling, next.tilted, next.anchored);
        setResult(next, target);
      } catch (err) {
        console.error('[Physics] simulation failed:', err);
        toast.error('Physics simulation failed');
        setRunning(false);
      }
    },
    [bim, settings, applyColorize, setRunning, setResult],
  );

  const handleRunFromSelection = useCallback(() => {
    if (!selectedTarget) return;
    void runSimulation(selectedTarget);
  }, [runSimulation, selectedTarget]);

  const handleRerun = useCallback(() => {
    if (!removed) return;
    void runSimulation(removed);
  }, [runSimulation, removed]);

  const handleReset = useCallback(() => {
    bim.viewer.resetColors();
    clearResult();
  }, [bim, clearResult]);

  const total = result?.bodies.length ?? 0;
  const fallingPct = total > 0 && result ? Math.round((result.falling.length / total) * 100) : 0;
  const target = removed ?? selectedTarget;
  const targetLabel = target
    ? target.name || `${target.ifcType || 'Entity'} #${target.ref.expressId}`
    : 'No selection';

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <div className="flex items-center gap-2">
          <Bomb className="h-4 w-4 text-red-600" />
          <h2 className="font-medium text-sm">Physics What-If</h2>
          {result && (
            <Badge variant="secondary" className="text-xs">
              {result.falling.length + result.tilted.length} affected
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant={showSettings ? 'secondary' : 'ghost'}
            size="icon"
            className="h-7 w-7"
            onClick={() => setShowSettings((v) => !v)}
            title="Settings"
          >
            <Settings className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose} title="Close">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        {/* Target row */}
        <section className="px-3 py-3 border-b border-border space-y-2">
          <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
            <Target className="h-3 w-3" />
            Target
          </div>
          <div className="text-sm font-medium truncate">{targetLabel}</div>
          {target && (
            <div className="text-xs text-muted-foreground truncate">
              {target.ifcType || '(unknown type)'} · model {target.ref.modelId}
            </div>
          )}
          <div className="flex gap-2 pt-1">
            <Button
              size="sm"
              className="flex-1"
              disabled={running || !selectedTarget}
              onClick={handleRunFromSelection}
              title={selectedTarget ? 'Run physics on the selected element' : 'Select an element first'}
            >
              {running ? (
                <>
                  <RefreshCw className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  Running…
                </>
              ) : (
                <>
                  <Play className="h-3.5 w-3.5 mr-1.5" />
                  Can I remove this?
                </>
              )}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={running || !removed}
              onClick={handleRerun}
              title="Re-run with the same target"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={running || !result}
              onClick={handleReset}
              title="Clear physics colorize"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </Button>
          </div>
        </section>

        {/* Playback */}
        {result?.trajectory && (
          <PlaybackBlock
            frameCount={result.trajectory.frameCount}
            frameDt={result.trajectory.frameDt}
            playback={playback}
            onChange={setPlayback}
          />
        )}

        {/* Settings */}
        {showSettings && (
          <SettingsBlock settings={settings} onChange={updateSettings} />
        )}

        {/* Result */}
        {result ? (
          <ResultBlock result={result} fallingPct={fallingPct} />
        ) : (
          <EmptyState />
        )}
      </div>
    </div>
  );
}

interface SettingsBlockProps {
  settings: PhysicsPanelSettings;
  onChange: (patch: Partial<PhysicsPanelSettings>) => void;
}

function SettingsBlock({ settings, onChange }: SettingsBlockProps) {
  return (
    <section className="px-3 py-3 border-b border-border space-y-3">
      <div className="text-xs uppercase tracking-wider text-muted-foreground">Settings</div>
      <SliderRow
        label="Duration"
        unit="s"
        value={settings.durationSeconds}
        min={0.5}
        max={5}
        step={0.5}
        onChange={(v) => onChange({ durationSeconds: v })}
        hint="Total simulated time. Longer = more settling, slower."
      />
      <SliderRow
        label="Fall threshold"
        unit="m"
        value={settings.fallThreshold}
        min={0.05}
        max={1}
        step={0.05}
        onChange={(v) => onChange({ fallThreshold: v })}
        hint="Vertical drop above which a body is classified as falling."
      />
      <SliderRow
        label="Tilt threshold"
        unit="rad"
        value={settings.tiltThreshold}
        min={0.01}
        max={0.5}
        step={0.01}
        onChange={(v) => onChange({ tiltThreshold: v })}
        hint="Rotation magnitude above which a non-falling body is tilted."
      />
      <SliderRow
        label="Adjacency tolerance"
        unit="m"
        value={settings.adjacencyTolerance}
        min={0.0}
        max={0.5}
        step={0.01}
        onChange={(v) => onChange({ adjacencyTolerance: v })}
        hint="AABB inflation when inferring fixed joints between elements."
      />
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-xs">
          <span>Collider strategy</span>
        </div>
        <div className="flex gap-1">
          {(['auto', 'convexHull', 'trimesh'] as PhysicsColliderStrategy[]).map((mode) => (
            <button
              key={mode}
              type="button"
              className={
                'flex-1 text-xs py-1 rounded border ' +
                (settings.colliderStrategy === mode
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'border-border hover:bg-accent')
              }
              onClick={() => onChange({ colliderStrategy: mode })}
            >
              {mode === 'convexHull' ? 'convex' : mode}
            </button>
          ))}
        </div>
        <p className="text-[10px] text-muted-foreground leading-tight">
          Auto picks convex for columns/beams/members and trimesh for slabs/walls.
        </p>
      </div>
    </section>
  );
}

interface SliderRowProps {
  label: string;
  unit: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  hint?: string;
}

function SliderRow({ label, unit, value, min, max, step, onChange, hint }: SliderRowProps) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span>{label}</span>
        <span className="tabular-nums text-muted-foreground">
          {value.toFixed(step < 1 ? 2 : 1)} {unit}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-primary"
      />
      {hint && <p className="text-[10px] text-muted-foreground leading-tight">{hint}</p>}
    </div>
  );
}

function ResultBlock({
  result,
  fallingPct,
}: {
  result: PhysicsSimulationResult;
  fallingPct: number;
}) {
  return (
    <section className="px-3 py-3 space-y-3">
      <div className="text-xs uppercase tracking-wider text-muted-foreground">Result</div>
      <div className="space-y-1.5">
        <Row swatch="bg-red-600" label="Falling" count={result.falling.length} />
        <Row swatch="bg-amber-500" label="Tilted" count={result.tilted.length} />
        <Row swatch="bg-blue-500/60" label="Anchored" count={result.anchored.length} />
        <Row swatch="bg-zinc-300 dark:bg-zinc-600" label="Stable" count={result.stable.length} />
      </div>
      <div className="text-[11px] text-muted-foreground">
        {result.bodies.length} bodies · {result.joints.length} joints · {fallingPct}% would fall
      </div>

      {result.falling.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer hover:text-foreground text-muted-foreground select-none">
            Falling express IDs ({result.falling.length})
          </summary>
          <div className="mt-1.5 max-h-40 overflow-y-auto rounded border border-border bg-muted/40 px-2 py-1 font-mono text-[10px] tabular-nums">
            {result.falling.slice(0, 200).join(', ')}
            {result.falling.length > 200 && ` … +${result.falling.length - 200} more`}
          </div>
        </details>
      )}
      {result.tilted.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer hover:text-foreground text-muted-foreground select-none">
            Tilted express IDs ({result.tilted.length})
          </summary>
          <div className="mt-1.5 max-h-40 overflow-y-auto rounded border border-border bg-muted/40 px-2 py-1 font-mono text-[10px] tabular-nums">
            {result.tilted.slice(0, 200).join(', ')}
            {result.tilted.length > 200 && ` … +${result.tilted.length - 200} more`}
          </div>
        </details>
      )}

      <p className="text-[10px] text-muted-foreground leading-snug pt-1">
        Plausibility check, not engineering: rigid bodies only — no bending,
        buckling, or material yield. For real structural analysis use an FEM
        tool fed via IfcStructuralAnalysisModel.
      </p>
    </section>
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

function EmptyState() {
  return (
    <section className="px-4 py-8 text-center text-xs text-muted-foreground space-y-2">
      <p>Select an element in the viewport, then click "Can I remove this?".</p>
      <p>
        Falling = the element drops once the target is gone. Tilted = it
        leans but stays. Anchored = treated as fixed (footings, piles, slabs
        on the model floor).
      </p>
    </section>
  );
}

interface PlaybackBlockProps {
  frameCount: number;
  frameDt: number;
  playback: PhysicsPlaybackState;
  onChange: (patch: Partial<PhysicsPlaybackState>) => void;
}

const SPEED_OPTIONS = [0.25, 0.5, 1, 2, 4];

function PlaybackBlock({ frameCount, frameDt, playback, onChange }: PlaybackBlockProps) {
  const totalSeconds = frameCount * frameDt;
  const currentSeconds = playback.frame * frameDt;
  const atEnd = playback.frame >= frameCount - 1;

  return (
    <section className="px-3 py-3 border-b border-border space-y-2">
      <div className="flex items-center justify-between text-xs uppercase tracking-wider text-muted-foreground">
        <span>Playback</span>
        <span className="tabular-nums normal-case text-[10px] text-muted-foreground">
          {currentSeconds.toFixed(2)}s / {totalSeconds.toFixed(2)}s
        </span>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="inline-flex items-center justify-center h-7 w-7 rounded border border-border hover:bg-accent"
          onClick={() => {
            if (atEnd && !playback.isPlaying) {
              // Restart from the beginning when hitting Play after finish.
              onChange({ frame: 0, isPlaying: true });
            } else {
              onChange({ isPlaying: !playback.isPlaying });
            }
          }}
          title={playback.isPlaying ? 'Pause' : atEnd ? 'Replay' : 'Play'}
        >
          {playback.isPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          className="inline-flex items-center justify-center h-7 w-7 rounded border border-border hover:bg-accent"
          onClick={() => onChange({ frame: 0, isPlaying: false })}
          title="Restart"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className={
            'inline-flex items-center justify-center h-7 w-7 rounded border ' +
            (playback.loop ? 'bg-primary text-primary-foreground border-primary' : 'border-border hover:bg-accent')
          }
          onClick={() => onChange({ loop: !playback.loop })}
          title="Loop"
        >
          <Repeat className="h-3.5 w-3.5" />
        </button>
        <select
          className="text-xs bg-background border border-border rounded px-1 h-7"
          value={playback.speed}
          onChange={(e) => onChange({ speed: Number(e.target.value) })}
          title="Playback speed"
        >
          {SPEED_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s}×
            </option>
          ))}
        </select>
      </div>
      <input
        type="range"
        min={0}
        max={Math.max(0, frameCount - 1)}
        step={1}
        value={playback.frame}
        onChange={(e) =>
          onChange({ frame: Number(e.target.value), isPlaying: false })
        }
        className="w-full accent-primary"
      />
      <p className="text-[10px] text-muted-foreground leading-tight">
        Scrub the timeline to inspect any moment, or hit Play to watch the
        what-if collapse unfold.
      </p>
    </section>
  );
}
