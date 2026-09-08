/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Compare panel's run controls (issue #924): A/B model pickers, the
 * data/geometry/both scope, the display + matching toggles, the run button and
 * the in-line warnings. Extracted from `ComparePanel` so both stay under the
 * module-size house rule (AGENTS.md) once content matching (#1891) added its
 * own toggle here.
 *
 * Deliberately presentational - every piece of state is owned by the store and
 * threaded in, so this file has no behaviour to test beyond wiring.
 */

import { Loader2, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { tourAnchor, TOUR_ANCHORS } from '@/lib/tours/anchors';
import type { DiffScope } from '@ifc-lite/diff';
import { CompareBlacklist } from './CompareBlacklist';
import type { ChangedTypeCount } from './changeRow';

const SCOPES: { id: DiffScope; label: string }[] = [
  { id: 'both', label: 'Both' },
  { id: 'data', label: 'Data' },
  { id: 'geometry', label: 'Geometry' },
];

interface CompareRunControlsProps {
  models: { id: string; name: string }[];
  baseModelId: string | null;
  headModelId: string | null;
  onBaseModelId: (id: string) => void;
  onHeadModelId: (id: string) => void;
  scope: DiffScope;
  onScope: (scope: DiffScope) => void;
  showUnchanged: boolean;
  onShowUnchanged: (show: boolean) => void;
  matchByContent: boolean;
  onMatchByContent: (enabled: boolean) => void;
  canRun: boolean;
  running: boolean;
  onRun: () => void;
  error: string | null;
  /** Show the "no geometry fingerprints" warning (result-dependent). */
  geometryUnavailable: boolean;
  /** Placement fingerprints are still comparing moves (symmetric mesh-less
   *  pair) — the warning must not claim geometry changes are undetectable
   *  while the panel's own rows report placement-driven ones. */
  placementOnlyGeometry: boolean;
  excludedTypes: string[];
  changedTypeCounts: ChangedTypeCount[];
  onAddExcludedType: (type: string) => void;
  onRemoveExcludedType: (type: string) => void;
  onClearExcludedTypes: () => void;
}

export function CompareRunControls({
  models,
  baseModelId,
  headModelId,
  onBaseModelId,
  onHeadModelId,
  scope,
  onScope,
  showUnchanged,
  onShowUnchanged,
  matchByContent,
  onMatchByContent,
  canRun,
  running,
  onRun,
  error,
  geometryUnavailable,
  placementOnlyGeometry,
  excludedTypes,
  changedTypeCounts,
  onAddExcludedType,
  onRemoveExcludedType,
  onClearExcludedTypes,
}: CompareRunControlsProps) {
  return (
    <div className="p-3 space-y-3 border-b border-border">
      <div
        className="grid grid-cols-[1.25rem_1fr] items-center gap-x-2 gap-y-2 text-xs"
        {...tourAnchor(TOUR_ANCHORS.compareAb)}
      >
        <span className="text-muted-foreground">A</span>
        <select
          value={baseModelId ?? ''}
          onChange={(e) => onBaseModelId(e.target.value)}
          className="w-full rounded border border-border bg-transparent px-2 py-1 text-foreground min-w-0"
        >
          {models.map((m) => (
            <option key={m.id} value={m.id}>{m.name}</option>
          ))}
        </select>
        <span className="text-muted-foreground">B</span>
        <select
          value={headModelId ?? ''}
          onChange={(e) => onHeadModelId(e.target.value)}
          className="w-full rounded border border-border bg-transparent px-2 py-1 text-foreground min-w-0"
        >
          {models.map((m) => (
            <option key={m.id} value={m.id}>{m.name}</option>
          ))}
        </select>
      </div>

      {baseModelId === headModelId && (
        <p className="text-xs text-[#e0af68]">Pick two different models.</p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-md border border-border overflow-hidden text-xs shrink-0">
          {SCOPES.map((s) => (
            <button
              key={s.id}
              onClick={() => onScope(s.id)}
              className={cn(
                'px-2.5 py-1 transition-colors',
                scope === s.id ? 'bg-primary text-primary-foreground' : 'hover:bg-muted',
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showUnchanged}
            onChange={(e) => onShowUnchanged(e.target.checked)}
          />
          Show unchanged
        </label>
      </div>

      {/* Content matching (#1891). On by default: without it a from-scratch
          re-export reads as "everything deleted, everything added". Off is the
          honest fallback when GlobalIds ARE stable and every match would be a
          guess the user does not want. */}
      <label className="flex items-start gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={matchByContent}
          onChange={(e) => onMatchByContent(e.target.checked)}
        />
        <span>
          Match re-exported elements by content
          <span className="block text-[10px] opacity-70">
            Re-pairs elements whose GlobalId changed but whose content did not.
          </span>
        </span>
      </label>

      <Button
        size="sm"
        className="w-full gap-1.5"
        disabled={!canRun}
        onClick={onRun}
        {...tourAnchor(TOUR_ANCHORS.compareRun)}
      >
        {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
        {running ? 'Comparing…' : 'Run comparison'}
      </Button>

      {error && <p className="text-xs text-[#f7768e]">{error}</p>}

      {geometryUnavailable && scope !== 'data' && (
        <p className="text-xs text-[#e0af68]">
          {placementOnlyGeometry
            ? 'Neither model has mesh geometry fingerprints (loaded outside ' +
              'the WASM mesh path), so SHAPE changes can’t be detected. ' +
              'Placement-driven moves and data changes are still compared.'
            : 'One model has no geometry fingerprints (loaded outside the ' +
              'WASM mesh path), so geometry changes can’t be detected. Data ' +
              'changes are still accurate — switch to the Data scope for ' +
              'reliable results.'}
        </p>
      )}

      {/* Ignored classes - blacklist noisy types out of the diff (#1470).
          Compact, in-line with the run controls; self-hides when empty. */}
      <CompareBlacklist
        excludedTypes={excludedTypes}
        changedTypeCounts={changedTypeCounts}
        onAdd={onAddExcludedType}
        onRemove={onRemoveExcludedType}
        onClear={onClearExcludedTypes}
      />
    </div>
  );
}
