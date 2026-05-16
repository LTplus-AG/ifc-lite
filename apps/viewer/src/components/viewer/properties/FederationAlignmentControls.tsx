/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Federation alignment controls — surfaces per-model alignment status, anchor
 * selection, and an explicit "Re-align federation" action.
 *
 * Lives inside GeoreferencingPanel (one instance per model). When only one
 * model is loaded the controls are hidden — alignment is a federation concept.
 */

import { useCallback, useMemo, useState } from 'react';
import { Anchor, RefreshCw, AlertTriangle, Check } from 'lucide-react';
import { useViewerStore } from '@/store';
import { useIfc } from '@/hooks/useIfc';
import type { FederatedModel } from '@/store/types';

export interface FederationAlignmentControlsProps {
  modelId: string;
}

function statusLabel(status: FederatedModel['federationAlignmentStatus']): {
  text: string;
  tone: 'anchor' | 'ok' | 'warn' | 'neutral';
  icon: typeof Check;
} {
  switch (status) {
    case 'anchor':
      return { text: 'Federation anchor', tone: 'anchor', icon: Anchor };
    case 'same-crs':
      return { text: 'Aligned (same CRS)', tone: 'ok', icon: Check };
    case 'reprojected':
      return { text: 'Reprojected to anchor CRS', tone: 'ok', icon: Check };
    case 'identity':
      return { text: 'Aligned (identity)', tone: 'ok', icon: Check };
    case 'failed':
      return { text: 'Alignment failed', tone: 'warn', icon: AlertTriangle };
    case 'none':
    case undefined:
      return { text: 'Not aligned', tone: 'neutral', icon: Anchor };
  }
}

const toneClasses = {
  anchor: 'border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-200',
  ok: 'border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-200',
  warn: 'border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-950/40 text-red-800 dark:text-red-200',
  neutral: 'border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 text-zinc-600 dark:text-zinc-400',
} as const;

export function FederationAlignmentControls({ modelId }: FederationAlignmentControlsProps) {
  const models = useViewerStore((s) => s.models);
  const anchorModelIdOverride = useViewerStore((s) => s.anchorModelIdOverride);
  const setAnchorModelIdOverride = useViewerStore((s) => s.setAnchorModelIdOverride);
  const { realignFederation } = useIfc();
  const [busy, setBusy] = useState(false);

  // The "effective anchor" matches findReferenceGeorefModel: the override if
  // it points to a loaded georeferenced model, otherwise the earliest-loaded
  // model with a georef. Re-derived here so the badge reflects truth without
  // adding another selector to the store.
  const effectiveAnchorId = useMemo(() => {
    if (anchorModelIdOverride && models.has(anchorModelIdOverride)) {
      const anchor = models.get(anchorModelIdOverride);
      if (anchor?.federationAlignmentStatus !== undefined) return anchorModelIdOverride;
    }
    const sorted = Array.from(models.entries()).sort(
      ([, a], [, b]) => (a.loadedAt ?? 0) - (b.loadedAt ?? 0),
    );
    for (const [id, model] of sorted) {
      if (model.federationAlignmentStatus) return id;
    }
    return sorted[0]?.[0] ?? null;
  }, [models, anchorModelIdOverride]);

  const thisModel = models.get(modelId);
  if (!thisModel) return null;
  if (models.size < 2) return null;

  const isAnchor = effectiveAnchorId === modelId;
  const status: FederatedModel['federationAlignmentStatus'] = isAnchor
    ? 'anchor'
    : thisModel.federationAlignmentStatus ?? 'none';
  const badge = statusLabel(status);
  const Icon = badge.icon;

  const handleSetAnchor = useCallback(() => {
    setAnchorModelIdOverride(modelId);
  }, [modelId, setAnchorModelIdOverride]);

  const handleClearAnchor = useCallback(() => {
    setAnchorModelIdOverride(null);
  }, [setAnchorModelIdOverride]);

  const handleRealign = useCallback(async () => {
    setBusy(true);
    try {
      await realignFederation();
    } finally {
      setBusy(false);
    }
  }, [realignFederation]);

  return (
    <div className="px-2 py-1.5 border-b border-zinc-100 dark:border-zinc-900">
      <div className="flex items-center gap-2 flex-wrap">
        <div
          className={`inline-flex items-center gap-1 px-1.5 py-0.5 border text-[10px] font-medium ${toneClasses[badge.tone]}`}
        >
          <Icon className="h-2.5 w-2.5" />
          <span>{badge.text}</span>
        </div>
        {!isAnchor && (
          <button
            type="button"
            onClick={handleSetAnchor}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-teal-600 dark:text-teal-400 hover:text-teal-800 dark:hover:text-teal-300 border border-teal-300/50 dark:border-teal-700/50 hover:bg-teal-50 dark:hover:bg-teal-950/50 transition-colors"
            title="Use this model as the federation anchor. Click 'Re-align' afterwards to apply."
          >
            <Anchor className="h-2.5 w-2.5" />
            Make anchor
          </button>
        )}
        {isAnchor && anchorModelIdOverride === modelId && (
          <button
            type="button"
            onClick={handleClearAnchor}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-zinc-600 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200 border border-zinc-300/50 dark:border-zinc-700/50 hover:bg-zinc-50 dark:hover:bg-zinc-900 transition-colors"
            title="Stop pinning this model as the anchor; revert to the default (earliest-loaded with georef)."
          >
            Unpin
          </button>
        )}
        <button
          type="button"
          onClick={handleRealign}
          disabled={busy}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-zinc-700 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-zinc-100 border border-zinc-300/50 dark:border-zinc-700/50 hover:bg-zinc-50 dark:hover:bg-zinc-900 transition-colors disabled:opacity-50 disabled:cursor-not-allowed ml-auto"
          title="Re-bake every model's geometry against the current anchor."
        >
          <RefreshCw className={`h-2.5 w-2.5 ${busy ? 'animate-spin' : ''}`} />
          Re-align
        </button>
      </div>
    </div>
  );
}
