/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Raw STEP tab content — lists every positional argument on the
 * selected entity with an inline editor for each scalar value, and
 * lets the user drill into `#N` references to chase the graph
 * (auto-skipping trivial single-ref wrappers along the way). The
 * entry point for `bim.store.setPositionalAttribute` from the UI.
 *
 * This is intentionally close-to-the-metal: STEP literals are shown
 * verbatim, no friendly transforms, and the help line at the bottom
 * documents the convention so a power user with `IfcRectangleProfileDef`
 * open can edit `XDim` without consulting the script panel.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ChevronRight, FileBox, Info, Sparkles } from 'lucide-react';
import { getAttributeNames } from '@ifc-lite/parser';
import type { EntityRef } from '@ifc-lite/parser';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { IfcAttributeValue } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { RawStepRow } from './RawStepRow';
import { extractRawStepTokens, serializeStepToken } from './raw-step-format';

/** Max wrappers to skip when auto-following a `#N` click. Caps the
 *  loop in case of cyclic STEP graphs (shouldn't happen in valid
 *  IFC, but stay defensive). */
const AUTO_FOLLOW_DEPTH = 16;

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

/**
 * Read raw STEP tokens for an entity by id. Returns null if the entity
 * is overlay-only or the source bytes can't be parsed.
 */
function readSourceTokens(dataStore: IfcDataStore | null, expressId: number): string[] | null {
  if (!dataStore?.source) return null;
  const ref: EntityRef | undefined = dataStore.entityIndex.byId.get(expressId);
  if (!ref || ref.byteLength <= 0) return null;
  return extractRawStepTokens(dataStore.source, ref.byteOffset, ref.byteLength);
}

/**
 * If the target entity is a single-positional-arg wrapper whose only
 * arg is itself a `#N` reference, follow that chain. Returns the
 * deepest "meaningful" expressId — the first one whose body has more
 * than one arg, or whose single arg isn't a reference. Caps recursion
 * at AUTO_FOLLOW_DEPTH and bails on tombstoned entities.
 */
function autoFollowWrappers(
  startId: number,
  dataStore: IfcDataStore | null,
  isDeleted: (id: number) => boolean,
): number {
  let current = startId;
  for (let i = 0; i < AUTO_FOLLOW_DEPTH; i++) {
    if (isDeleted(current)) return current;
    const tokens = readSourceTokens(dataStore, current);
    if (!tokens || tokens.length !== 1) return current;
    const m = tokens[0].match(/^#(\d+)$/);
    if (!m) return current;
    const next = Number.parseInt(m[1], 10);
    if (!Number.isFinite(next) || next === current) return current;
    current = next;
  }
  return current;
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

  // Drill-through navigation. The stack holds expressIds the user has
  // clicked into; an empty stack means "show the 3D-selected entity".
  // Reset whenever the root selection changes — drilling stays scoped
  // to a single 3D click, otherwise the UI feels haunted.
  const [navStack, setNavStack] = useState<number[]>([]);
  useEffect(() => {
    setNavStack([]);
  }, [modelId, entityId]);

  const currentId = navStack.length > 0 ? navStack[navStack.length - 1] : entityId;
  const isAtRoot = navStack.length === 0;

  // Resolve the current entity's type for the header. Lookup order:
  //   1. The 3D-selected root carries its type via `entityType`.
  //   2. The parsed data store knows source-buffer entities by id.
  //   3. Overlay-only entities (drill-create / duplicate) live in the
  //      mutation view's `newEntities` map — without this fallback
  //      drilled overlay entities would lose schema-aware attribute
  //      labels and render as `#<id>`.
  const currentType = useMemo(() => {
    if (currentId === entityId) return entityType;
    const t = dataStore?.entities.getTypeName(currentId);
    if (t) return t;
    const view = getMutationView(modelId);
    const overlay = view?.getNewEntity(currentId);
    if (overlay) return overlay.type;
    return `#${currentId}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId, entityId, entityType, dataStore, modelId, getMutationView, mutationVersion]);

  // Resolve display tokens for the *current* entity. Tokenize the raw
  // STEP body when source bytes exist, fall back to overlay-only
  // NewEntity records otherwise. Per-index overrides land on top.
  const { tokens, isOverlayOnly, overlayMap } = useMemo(() => {
    const view = getMutationView(modelId);
    const overlay = view?.getPositionalMutationsForEntity(currentId) ?? null;

    const sourceTokens = readSourceTokens(dataStore, currentId);
    if (sourceTokens) {
      return {
        tokens: applyOverlayTokens(sourceTokens, overlay),
        isOverlayOnly: false,
        overlayMap: overlay,
      };
    }

    if (view) {
      const overlayEntity = view.getNewEntity(currentId);
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
  }, [dataStore, currentId, modelId, getMutationView, mutationVersion]);

  // Schema attribute names for the current type. Falls back to
  // "Arg N" for entities the generated registry doesn't know.
  const attributeNames = useMemo(() => getAttributeNames(currentType) ?? [], [currentType]);

  // Per-row mutation indicator — drives the purple dot.
  const mutatedIndices = useMemo(() => {
    if (!overlayMap) return new Set<number>();
    return new Set(overlayMap.keys());
  }, [overlayMap]);

  // Drill into a `#N` reference, auto-skipping trivial wrappers so a
  // single click takes the user from `OwnerHistory → IfcOwnerHistory`
  // (one hop) without three intermediate stops on identity-only
  // wrapper entities.
  const handleNavigate = useCallback(
    (refId: number) => {
      const view = getMutationView(modelId);
      const isDeleted = (id: number) => view?.isDeleted?.(id) ?? false;
      const target = autoFollowWrappers(refId, dataStore, isDeleted);
      setNavStack((prev) => {
        // No-op if the user is already viewing the target — refs that
        // self-loop or land on the current node would otherwise grow
        // the breadcrumb forever.
        const tail = prev.length > 0 ? prev[prev.length - 1] : entityId;
        if (target === tail) return prev;
        return [...prev, target];
      });
    },
    [dataStore, modelId, entityId, getMutationView],
  );

  const handleBack = useCallback(() => {
    setNavStack((prev) => prev.slice(0, -1));
  }, []);

  const handleResetToRoot = useCallback(() => {
    setNavStack([]);
  }, []);

  if (!tokens || tokens.length === 0) {
    return (
      <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-6 text-center">
        <FileBox className="h-5 w-5 mx-auto mb-2 text-zinc-400" />
        <p className="text-xs font-mono text-zinc-500 dark:text-zinc-500">
          {dataStore
            ? `Entity #${currentId} has no positional STEP arguments`
            : 'Raw STEP is unavailable for this model'}
        </p>
        {!isAtRoot && (
          <button
            type="button"
            onClick={handleResetToRoot}
            className="mt-3 text-[10px] font-mono text-emerald-600 dark:text-emerald-400 hover:underline"
          >
            ← Back to {entityType} #{entityId}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 overflow-hidden">
      {/* Breadcrumb (only when drilled in) */}
      {!isAtRoot && (
        <div className="flex items-center gap-1 px-2 py-1.5 border-b border-zinc-200 dark:border-zinc-800 bg-emerald-50/40 dark:bg-emerald-950/15 text-[10px] font-mono">
          <button
            type="button"
            onClick={handleBack}
            className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded hover:bg-emerald-100 dark:hover:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400"
            title="Back one step"
          >
            <ArrowLeft className="h-3 w-3" />
            <span>back</span>
          </button>
          <button
            type="button"
            onClick={handleResetToRoot}
            className="px-1 py-0.5 rounded text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 truncate"
            title={`Back to selected entity ${entityType} #${entityId}`}
          >
            {entityType} #{entityId}
          </button>
          {navStack.map((id, i) => (
            <span key={`${id}-${i}`} className="flex items-center gap-1 min-w-0">
              <ChevronRight className="h-3 w-3 text-zinc-400 shrink-0" />
              <button
                type="button"
                onClick={() => setNavStack(navStack.slice(0, i + 1))}
                disabled={i === navStack.length - 1}
                className="px-1 py-0.5 rounded text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:hover:bg-transparent disabled:text-emerald-700 dark:disabled:text-emerald-400 disabled:font-semibold truncate"
              >
                #{id}
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50/80 dark:bg-zinc-900/40">
        <div className="flex items-center gap-2 min-w-0">
          <FileBox className="h-3.5 w-3.5 text-purple-600 dark:text-purple-400 shrink-0" />
          <span
            className="font-mono text-[11px] font-semibold tracking-wide uppercase text-zinc-700 dark:text-zinc-200 truncate"
            title={`${currentType} #${currentId}`}
          >
            {currentType} #{currentId}
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
              entityId={currentId}
              index={idx}
              name={name}
              displayToken={token}
              isMutated={mutatedIndices.has(idx)}
              enableEditing={enableEditing}
              onNavigate={handleNavigate}
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
          <code className="px-0.5 rounded bg-zinc-200/60 dark:bg-zinc-800/60">#42</code> for refs (click to drill),{' '}
          <code className="px-0.5 rounded bg-zinc-200/60 dark:bg-zinc-800/60">.AREA.</code> for enums. Edits
          land on the export overlay — undo/redo via the toolbar.
        </p>
      </div>
    </div>
  );
}
