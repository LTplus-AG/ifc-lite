/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Lens evaluation hook
 *
 * Evaluates active lens rules against all entities across all models,
 * producing a color map and hidden IDs set that are applied to the renderer.
 * Unmatched entities with geometry are ghosted (semi-transparent).
 *
 * The pure evaluation logic lives in @ifc-lite/lens — this hook handles
 * React lifecycle and Zustand integration: evaluation, and the sync of the
 * active lens's hidden ids into the shared `hiddenEntities` channel. It is
 * mounted once, by `LensRuntimeHost`, so an active lens keeps applying while
 * its panel is closed (#5877).
 *
 * Performance notes:
 * - Does NOT subscribe to `models` or `ifcDataStore` directly — reads them
 *   from getState() only when the active lens changes OR the loaded MODEL
 *   SET changes (add/remove — tracked via a cheap id-set fingerprint, see
 *   `modelSetKey` below). This prevents re-evaluation on every in-place model
 *   field patch during loading (progress, visibility, …) while still
 *   invalidating when a model is actually added or removed (#2853-class:
 *   removeModel/clearAllModels can leave colorMap/hiddenIds/ruleEntityIds
 *   referencing entities that no longer exist, or — after clearAllModels
 *   resets the federation registry's offset counter — that a NEW model now
 *   occupies at the same global id).
 * - Uses color overlay system: pendingColorUpdates triggers
 *   scene.setColorOverrides(), which writes the renderer's per-entity colour
 *   table (#6076). Batches are NEVER modified or copied — clearing lens is
 *   instant (no batch rebuild).
 */

import { useEffect, useRef, useMemo } from 'react';
import { evaluateLens, evaluateAutoColorLens, rgbaToHex, isGhostColor } from '@ifc-lite/lens';
import type { AutoColorEvaluationResult } from '@ifc-lite/lens';
import { useViewerStore } from '@/store';
import { posthog } from '@/lib/analytics';
import { createLensDataProvider } from '@/lib/lens';
import { planLensHiddenSync, ruleIsolationOwnsChannel } from '@/components/viewer/lens-visibility-ownership';

const EMPTY_LENS_HIDDEN: ReadonlySet<number> = new Set<number>();

export function useLens(): void {
  const activeLensId = useViewerStore((s) => s.activeLensId);
  const savedLenses = useViewerStore((s) => s.savedLenses);

  // Derive the active lens object — only re-evaluates when activeLensId or
  // the active lens entry itself changes, not when unrelated lenses are edited.
  const activeLens = useMemo(
    () => savedLenses.find(l => l.id === activeLensId) ?? null,
    [activeLensId, savedLenses],
  );

  // Track the previously active lens to detect deactivation
  const prevLensIdRef = useRef<string | null>(null);

  // Fingerprint of the loaded MODEL SET (add/remove only) — deliberately not
  // `models` itself, which gets a new Map reference on every in-place field
  // patch (loading progress, visibility, etc.) and would defeat the whole
  // point of reading models from getState() instead of subscribing to them.
  // Two string values with the same content are `===` in JS, so this selector
  // only actually changes the deps array when the id SET changes.
  //
  // Why this matters: `removeModel` / `clearAllModels` can drop or replace
  // every model the last evaluation's colorMap/hiddenIds/ruleEntityIds refer
  // to. Worse, `clearAllModels` resets the federation registry's offset
  // counter (`federation-registry.ts`), so the next model loaded can be
  // handed the EXACT global-id range the stale entries still reference —
  // a stale lens color then keeps "matching" whatever unrelated entity now
  // occupies that id, not just dangling harmlessly.
  const modelSetKey = useViewerStore((s) => {
    const ids = Array.from(s.models.keys()).sort().join('\x00');
    return `${ids}|${s.ifcDataStore ? 1 : 0}`;
  });

  // Re-evaluate after a live property/attribute/quantity edit (#5207) — the
  // provider now reads the mutation overlay, so a rule keyed on an edited
  // value needs this bump to actually pick it up, same trigger
  // useAppearanceAssignments.ts already subscribes to for the same reason.
  const mutationVersion = useViewerStore((s) => s.mutationVersion);

  useEffect(() => {

    // Lens deactivated — clear overlay (instant, no batch rebuild)
    if (!activeLens && prevLensIdRef.current !== null) {
      prevLensIdRef.current = null;
      useViewerStore.getState().setLensColorMap(new Map());
      useViewerStore.getState().setLensHiddenIds(new Set());
      useViewerStore.getState().setLensRuleCounts(new Map());
      useViewerStore.getState().setLensRuleEntityIds(new Map());
      useViewerStore.getState().setLensAutoColorLegend([]);
      useViewerStore.getState().setLensAppliedColors(null);

      // Send empty map to signal "clear overlays" to useGeometryStreaming
      useViewerStore.getState().setPendingColorUpdates(new Map());
      return;
    }

    if (!activeLens) return;

    // Read data sources from getState() — NOT subscribed, so model loading
    // doesn't trigger re-evaluation
    const { models, ifcDataStore, mutationViews } = useViewerStore.getState();
    if (models.size === 0 && !ifcDataStore) {
      // Every model the last evaluation referenced is gone. Its
      // colorMap/hiddenIds/ruleEntityIds are not just dangling — after
      // clearAllModels resets the registry, the next model can reuse the
      // exact global-id range they point at, so leaving them in place risks
      // misapplying stale colors to an unrelated entity the moment anything
      // (e.g. useCompareOverlay's teardown) resends `lensAppliedColors`.
      // Clear the same way lens deactivation does.
      if (prevLensIdRef.current !== null) {
        prevLensIdRef.current = null;
        useViewerStore.getState().setLensColorMap(new Map());
        useViewerStore.getState().setLensHiddenIds(new Set());
        useViewerStore.getState().setLensRuleCounts(new Map());
        useViewerStore.getState().setLensRuleEntityIds(new Map());
        useViewerStore.getState().setLensAutoColorLegend([]);
        useViewerStore.getState().setLensAppliedColors(null);
        useViewerStore.getState().setPendingColorUpdates(new Map());
      }
      return;
    }

    prevLensIdRef.current = activeLensId;

    // Create data provider and evaluate lens using @ifc-lite/lens package
    const provider = createLensDataProvider(
      models, ifcDataStore, mutationViews,
      (globalId) => useViewerStore.getState().resolveGlobalIdFromModels(globalId),
    );

    // Dispatch: auto-color mode vs. rule-based mode
    const isAutoColor = !!activeLens.autoColor;
    const result = isAutoColor
      ? evaluateAutoColorLens(activeLens.autoColor!, provider)
      : evaluateLens(activeLens, provider);

    const { colorMap, hiddenIds, ruleCounts, ruleEntityIds } = result;

    // Build hex color map for UI legend (exclude ghost entries)
    const hexColorMap = new Map<number, string>();
    for (const [id, rgba] of colorMap) {
      if (!isGhostColor(rgba)) {
        hexColorMap.set(id, rgbaToHex(rgba));
      }
    }
    useViewerStore.getState().setLensColorMap(hexColorMap);
    useViewerStore.getState().setLensHiddenIds(hiddenIds);
    useViewerStore.getState().setLensRuleCounts(ruleCounts);
    useViewerStore.getState().setLensRuleEntityIds(ruleEntityIds);

    // Store auto-color legend entries for UI display
    if (isAutoColor && 'legend' in result) {
      useViewerStore.getState().setLensAutoColorLegend((result as AutoColorEvaluationResult).legend);
    } else {
      useViewerStore.getState().setLensAutoColorLegend([]);
    }

    // Apply colors via overlay system — original batches are never modified.
    // Remember the exact overlay so the compare overlay can restore it on
    // teardown instead of blanking the channel the lens still owns.
    useViewerStore.getState().setLensAppliedColors(colorMap.size > 0 ? colorMap : null);
    if (colorMap.size > 0) {
      useViewerStore.getState().setPendingColorUpdates(colorMap);
    }

    posthog.capture('lens_applied', {
      mode: isAutoColor ? 'auto_color' : 'rules',
      rule_count: activeLens.rules.length,
      auto_color_source: isAutoColor ? activeLens.autoColor?.source : undefined,
      matched_entity_count: colorMap.size,
      hidden_entity_count: hiddenIds.size,
    });
  }, [activeLensId, activeLens, modelSetKey, mutationVersion]);

  // Identity, not `.size`: the evaluation above replaces the Set on every
  // recompute, and a same-size content swap must still resync (#5206).
  const lensHiddenIds = useViewerStore((s) => s.lensHiddenIds);

  // planLensHiddenSync computes minimal show/hide deltas plus the ids the lens
  // OWNS afterwards (only ids it newly hid — an id the user manually hid
  // before or during the lens stays hidden after teardown). Ownership is
  // persisted in the store, so a remount re-runs this as a no-op instead of
  // losing track of (or double-claiming) the lens's hides.
  useEffect(() => {
    const state = useViewerStore.getState();
    const plan = planLensHiddenSync({
      applied: state.lensAppliedHiddenIds,
      hiddenEntities: state.hiddenEntities,
      lensHiddenIds: activeLensId ? lensHiddenIds : EMPTY_LENS_HIDDEN,
    });
    if (plan.show.length > 0) state.showEntities(plan.show);
    if (plan.hide.length > 0) state.hideEntities(plan.hide);
    if (plan.nextApplied.length > 0 || state.lensAppliedHiddenIds.length > 0) {
      state.setLensAppliedHiddenIds(plan.nextApplied);
    }
  }, [activeLensId, lensHiddenIds]);

  // A lens deactivated while its panel is closed (a flavor switch clears
  // activeLensId) leaves its recorded rule isolation with no owner. Release it
  // here, panel or not; the channel is cleared only if the lens still owns it,
  // so an isolation the user applied since is left alone.
  useEffect(() => {
    if (activeLensId !== null) return;
    const state = useViewerStore.getState();
    const isolation = state.lensRuleIsolation;
    if (!isolation) return;
    if (ruleIsolationOwnsChannel(state.isolatedEntities, isolation.entityIds)) state.clearIsolation();
    state.setLensRuleIsolation(null);
  }, [activeLensId]);
}
