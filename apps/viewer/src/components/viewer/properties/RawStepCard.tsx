/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Raw STEP tab content — lists every positional argument on the
 * selected entity with an inline editor for each scalar value. The
 * entry point for `bim.store.setPositionalAttribute` from the UI.
 *
 * This is intentionally close-to-the-metal: STEP literals are shown
 * verbatim, no friendly transforms, and the help line at the bottom
 * documents the convention so a power user with `IfcRectangleProfileDef`
 * open can edit `XDim` without consulting the script panel.
 */

import { useMemo } from 'react';
import { FileBox, Info, Sparkles } from 'lucide-react';
import { getAttributeNames } from '@ifc-lite/parser';
import type { EntityRef } from '@ifc-lite/parser';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { IfcAttributeValue } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { RawStepRow } from './RawStepRow';
import { extractRawStepTokens, serializeStepToken } from './raw-step-format';

/**
 * Apply per-index overlay overrides on top of the base STEP tokens.
 * Returns a fresh array so React detects the change. Out-of-range
 * indices are ignored — the StoreEditor refuses them on write, but
 * stay defensive in case the override map outlives the entity.
 */
function applyOverlayTokens(
  base: string[],
  overlay: Map<number, IfcAttributeValue> | null,
): string[] {
  if (!overlay || overlay.size === 0) return base;
  const merged = base.slice();
  for (const [index, value] of overlay) {
    if (index >= 0 && index < merged.length) {
      merged[index] = serializeStepToken(value);
    }
  }
  return merged;
}

interface RawStepCardProps {
  modelId: string;
  entityId: number;
  entityType: string;
  /** The active model's data store — needed to read the source bytes. */
  dataStore: IfcDataStore | null;
  /** Edit affordances are gated on edit mode (matches Properties tab). */
  enableEditing: boolean;
}

export function RawStepCard({
  modelId,
  entityId,
  entityType,
  dataStore,
  enableEditing,
}: RawStepCardProps) {
  // Subscribe to the mutation version so overlay overrides re-render
  // here exactly when they would in the Properties tab.
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const getMutationView = useViewerStore((s) => s.getMutationView);

  // Resolve display tokens. We tokenize the raw STEP body directly
  // so refs render as `#N`, enums stay `.AREA.`, and strings keep
  // their on-disk form — the EntityExtractor's parsed JS shape loses
  // that distinction (a ref `#42` comes back as a plain `42`). For
  // overlay-only entities we serialize the JS NewEntity attributes
  // back to STEP token form. Per-index overrides land on top.
  const { tokens, isOverlayOnly, overlayMap } = useMemo(() => {
    const view = getMutationView(modelId);
    const overlay = view?.getPositionalMutationsForEntity(entityId) ?? null;

    if (!dataStore) {
      return { tokens: null as string[] | null, isOverlayOnly: false, overlayMap: overlay };
    }

    // Source-buffer entity: tokenize the raw STEP text directly.
    const ref: EntityRef | undefined = dataStore.entityIndex.byId.get(entityId);
    if (ref && ref.byteLength > 0 && dataStore.source) {
      const baseTokens = extractRawStepTokens(dataStore.source, ref.byteOffset, ref.byteLength);
      if (baseTokens) {
        return {
          tokens: applyOverlayTokens(baseTokens, overlay),
          isOverlayOnly: false,
          overlayMap: overlay,
        };
      }
    }

    // Overlay-only entity: serialize the JS attribute list to STEP
    // tokens, then apply per-index overrides (rare for fresh
    // entities, but setPositionalAttribute is legal on them).
    if (view) {
      const overlayEntity = view.getNewEntity(entityId);
      if (overlayEntity) {
        const baseTokens = (overlayEntity.attributes as IfcAttributeValue[]).map(serializeStepToken);
        return {
          tokens: applyOverlayTokens(baseTokens, overlay),
          isOverlayOnly: true,
          overlayMap: overlay,
        };
      }
    }

    return { tokens: null as string[] | null, isOverlayOnly: false, overlayMap: overlay };
    // mutationVersion forces this hook to re-run when any overlay
    // (positional or overlay-entity) changes — overlay maps are
    // mutated in place, so identity-based memoization isn't enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataStore, entityId, modelId, getMutationView, mutationVersion]);

  // Schema attribute names. Falls back to "Arg N" for entities the
  // generated registry doesn't know — never invent a name.
  const attributeNames = useMemo(() => getAttributeNames(entityType) ?? [], [entityType]);

  // Per-row mutation indicator — drives the purple dot.
  const mutatedIndices = useMemo(() => {
    if (!overlayMap) return new Set<number>();
    return new Set(overlayMap.keys());
  }, [overlayMap]);

  if (!tokens || tokens.length === 0) {
    return (
      <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-6 text-center">
        <FileBox className="h-5 w-5 mx-auto mb-2 text-zinc-400" />
        <p className="text-xs font-mono text-zinc-500 dark:text-zinc-500">
          {dataStore
            ? 'Entity has no positional STEP arguments'
            : 'Raw STEP is unavailable for this model'}
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50/80 dark:bg-zinc-900/40">
        <div className="flex items-center gap-2 min-w-0">
          <FileBox className="h-3.5 w-3.5 text-purple-600 dark:text-purple-400 shrink-0" />
          <span
            className="font-mono text-[11px] font-semibold tracking-wide uppercase text-zinc-700 dark:text-zinc-200 truncate"
            title={`${entityType} #${entityId}`}
          >
            {entityType} #{entityId}
          </span>
        </div>
        {isOverlayOnly && (
          <span
            className="inline-flex items-center gap-1 rounded-sm border border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/40 px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider text-emerald-700 dark:text-emerald-300"
            title="This entity was added through the overlay (bim.store.addEntity / addColumn)."
          >
            <Sparkles className="h-2.5 w-2.5" />
            New
          </span>
        )}
      </div>

      {/* Rows */}
      <div className="divide-y-0">
        {tokens.map((token, idx) => {
          const name = attributeNames[idx] || `Arg ${idx}`;
          return (
            <RawStepRow
              key={idx}
              modelId={modelId}
              entityId={entityId}
              index={idx}
              name={name}
              displayToken={token}
              isMutated={mutatedIndices.has(idx)}
              enableEditing={enableEditing}
            />
          );
        })}
      </div>

      {/* Help footer */}
      <div className="flex items-start gap-2 px-3 py-2 border-t border-zinc-200 dark:border-zinc-800 bg-zinc-50/60 dark:bg-zinc-900/30">
        <Info className="h-3 w-3 mt-0.5 text-zinc-400 dark:text-zinc-500 shrink-0" />
        <p className="text-[10.5px] font-mono leading-relaxed text-zinc-500 dark:text-zinc-500">
          STEP literals: numbers, <code className="px-0.5 rounded bg-zinc-200/60 dark:bg-zinc-800/60">$</code> for null,{' '}
          <code className="px-0.5 rounded bg-zinc-200/60 dark:bg-zinc-800/60">.T.</code>/
          <code className="px-0.5 rounded bg-zinc-200/60 dark:bg-zinc-800/60">.F.</code> for booleans,{' '}
          <code className="px-0.5 rounded bg-zinc-200/60 dark:bg-zinc-800/60">#42</code> for refs,{' '}
          <code className="px-0.5 rounded bg-zinc-200/60 dark:bg-zinc-800/60">.AREA.</code> for enums. Edits
          land on the export overlay — undo/redo via the toolbar.
        </p>
      </div>
    </div>
  );
}
