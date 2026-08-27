/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { teardownOwnedKeys } from './teardown.js';
import { viewerTeardownRegistry } from './teardown-registry.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Every key a session reset actually WRITES, measured by running the registry.
 *
 * This is the list that matters. `owns` is a declaration; this is the emission,
 * and the two are equal only by hand. Deleting a line from a teardown BODY
 * while leaving its key in `owns` compiles clean (`Partial<Pick<...>>` does not
 * require the key), passes an owns-only pin, and silently stops clearing that
 * field on every file swap.
 */
const PINNED_SESSION_RESET_KEYS: readonly string[] = [
  'activeBasketViewId', 'activeChangeSetId', 'activeLensId', 'activeListId', 'activePresetId',
  'activeSheet', 'activeStorey', 'activeTool', 'activeTopicId', 'activeViewpointId',
  'activeWorkScheduleId', 'animationEnabled', 'annotation2DActiveTool',
  'annotation2DCursorPos', 'basketPresentationVisible', 'basketViews', 'bcfError',
  'bcfLoading', 'bcfPanelVisible', 'cameraRotation', 'cesiumAvailable', 'cesiumEnabled',
  'cesiumGlbLoaded', 'cesiumHeightsAreEllipsoidal', 'cesiumPlacementDraft',
  'cesiumPlacementDraftModelId', 'cesiumPlacementEditMode', 'cesiumSourceModelId',
  'cesiumTerrainClipY', 'cesiumTerrainHeight', 'cesiumTerrainSaveHeight', 'changeSets',
  'chatAbortController', 'chatError', 'chatStatus', 'chatStreamingContent', 'classFilter',
  'cloudAnnotation2DPoints', 'cloudAnnotations2D', 'compareError', 'compareResult',
  'compareRunning', 'compareSelectedKey', 'contactShadingIntensity', 'contactShadingQuality',
  'contactShadingRadius', 'contextMenu', 'customOverrideRules', 'dirtyModels', 'draft',
  'drawing2D', 'drawing2DDisplayOptions', 'drawing2DError', 'drawing2DPanelVisible',
  'drawing2DPhase', 'drawing2DProgress', 'drawing2DStatus', 'drawing2DSvgContent',
  'edgeContrastEnabled', 'edgeContrastIntensity', 'editEnabled', 'editingZone', 'error',
  'expandedTaskGlobalIds', 'ganttPanelVisible', 'generateScheduleDialogOpen',
  'geometryProgress', 'geometryStreamingActive', 'geometryUpdateTick', 'ghostExceptEntities',
  'hiddenEntities', 'hiddenEntitiesByModel', 'hierarchyBasketSelection', 'hoverState',
  'hoveredTaskGlobalId', 'idsActiveEntityId', 'idsActiveSpecificationId', 'idsError',
  'idsFocusVisibilityOwned', 'idsLoading', 'idsPanelVisible', 'idsProgress',
  'isolatedEntities', 'isolatedEntitiesByModel', 'lensAppliedHiddenIds', 'lensColorMap',
  'lensHiddenIds', 'lensPanelVisible', 'lensRuleCounts', 'lensRuleEntityIds',
  'lensRuleIsolation', 'listExecuting', 'listPanelVisible', 'listResult', 'loading',
  'measure2DCurrent', 'measure2DLockedAxis', 'measure2DMode', 'measure2DResults',
  'measure2DShiftLocked', 'measure2DSnapPoint', 'measure2DStart', 'meshColorBackup',
  'metadataProgress', 'mutationVersion', 'mutationViews', 'overridesEnabled',
  'overridesPanelVisible', 'pendingColorUpdates', 'pendingInstancedShards',
  'pendingMeshColorUpdates', 'pendingPropertyFocus', 'pinboardEntities', 'playbackIsPlaying',
  'playbackTime', 'pointCloudAlignmentAvailable', 'pointCloudAlignmentEnabled',
  'pointCloudAssetCount', 'pointCloudClassCounts', 'pointCloudClassMask',
  'pointCloudColorMode', 'pointCloudDeviationCenterOffset', 'pointCloudDeviationComputed',
  'pointCloudDeviationHalfRange', 'pointCloudEdlEnabled', 'pointCloudEdlStrength',
  'pointCloudFixedColor', 'pointCloudPointSize', 'pointCloudPreviewStride',
  'pointCloudRoundShape', 'pointCloudSizeMode', 'pointCloudWorldRadius', 'polygonArea2DPoints',
  'polygonArea2DResults', 'progress', 'projectionMode', 'redoStacks', 'scheduleData',
  'scheduleRange', 'scriptAssistantTurnSnapshot', 'scriptDeleteConfirmId',
  'scriptExecutionState', 'scriptLastDiagnostics', 'scriptLastError', 'scriptLastResult',
  'searchFieldFilter', 'searchFilter', 'searchFilterError', 'searchFilterResult',
  'searchFilterRunning', 'searchFilterSchema', 'searchHighlightIndex', 'searchIndexes',
  'searchModalOpen', 'searchModelFilter', 'searchOpen', 'searchQuery', 'searchVimCycle',
  'sectionPlane', 'selectedAnnotation2D', 'selectedAnnotationId', 'selectedEntities',
  'selectedEntitiesSet', 'selectedEntity', 'selectedEntityId', 'selectedEntityIds',
  'selectedModelId', 'selectedStoreys', 'selectedTaskGlobalIds', 'separationLinesEnabled',
  'separationLinesIntensity', 'separationLinesQuality', 'separationLinesRadius',
  'sheetEnabled', 'sheetPanelVisible', 'suppressNextSection2DPanelAutoOpen',
  'textAnnotation2DEditing', 'textAnnotations2D', 'titleBlockEditorVisible', 'typeViewMode',
  'typeVisibility', 'undoStacks', 'visualEnhancementsEnabled', 'zoneApportionment',
  'zoneAssignmentTiming', 'zoneAssignments',
];

/** The same, for `all-models-cleared`. */
const PINNED_ALL_MODELS_CLEARED_KEYS: readonly string[] = [
  'activeModelId', 'addElementModelId', 'addElementStoreyId', 'classFilter', 'geometryResult',
  'ghostExceptEntities', 'hiddenEntities', 'hiddenEntitiesByModel', 'hierarchyBasketSelection',
  'ifcDataStore', 'isolatedEntities', 'isolatedEntitiesByModel', 'meshColorBackup', 'models',
  'pinboardEntities', 'selectedEntityId', 'selectedEntityIds', 'selectedStoreys',
];

/**
 * Every key some slice DECLARES it may destroy, across all scopes.
 *
 * Wider than the emitted lists above by the six keys only a federation scope
 * writes (`models`, `activeModelId`, `ifcDataStore`, `geometryResult`,
 * `addElementModelId`, `addElementStoreyId`). Pinned so a key vanishing from an
 * `owns` list fails even when no scope emits it under an empty state.
 */
const PINNED_OWNED_KEYS: readonly string[] = [
  'activeBasketViewId', 'activeChangeSetId', 'activeLensId', 'activeListId', 'activeModelId',
  'activePresetId', 'activeSheet', 'activeStorey', 'activeTool', 'activeTopicId',
  'activeViewpointId', 'activeWorkScheduleId', 'addElementModelId', 'addElementStoreyId',
  'animationEnabled', 'annotation2DActiveTool', 'annotation2DCursorPos',
  'basketPresentationVisible', 'basketViews', 'bcfError', 'bcfLoading', 'bcfPanelVisible',
  'cameraRotation', 'cesiumAvailable', 'cesiumEnabled', 'cesiumGlbLoaded',
  'cesiumHeightsAreEllipsoidal', 'cesiumPlacementDraft', 'cesiumPlacementDraftModelId',
  'cesiumPlacementEditMode', 'cesiumSourceModelId', 'cesiumTerrainClipY',
  'cesiumTerrainHeight', 'cesiumTerrainSaveHeight', 'changeSets', 'chatAbortController',
  'chatError', 'chatStatus', 'chatStreamingContent', 'classFilter', 'cloudAnnotation2DPoints',
  'cloudAnnotations2D', 'compareError', 'compareResult', 'compareRunning',
  'compareSelectedKey', 'contactShadingIntensity', 'contactShadingQuality',
  'contactShadingRadius', 'contextMenu', 'customOverrideRules', 'dirtyModels', 'draft',
  'drawing2D', 'drawing2DDisplayOptions', 'drawing2DError', 'drawing2DPanelVisible',
  'drawing2DPhase', 'drawing2DProgress', 'drawing2DStatus', 'drawing2DSvgContent',
  'edgeContrastEnabled', 'edgeContrastIntensity', 'editEnabled', 'editingZone', 'error',
  'expandedTaskGlobalIds', 'ganttPanelVisible', 'generateScheduleDialogOpen',
  'geometryProgress', 'geometryResult', 'geometryStreamingActive', 'geometryUpdateTick',
  'ghostExceptEntities', 'hiddenEntities', 'hiddenEntitiesByModel', 'hierarchyBasketSelection',
  'hoverState', 'hoveredTaskGlobalId', 'idsActiveEntityId', 'idsActiveSpecificationId',
  'idsError', 'idsFocusVisibilityOwned', 'idsLoading', 'idsPanelVisible', 'idsProgress',
  'ifcDataStore', 'isolatedEntities', 'isolatedEntitiesByModel', 'lensAppliedHiddenIds',
  'lensColorMap', 'lensHiddenIds', 'lensPanelVisible', 'lensRuleCounts', 'lensRuleEntityIds',
  'lensRuleIsolation', 'listExecuting', 'listPanelVisible', 'listResult', 'loading',
  'measure2DCurrent', 'measure2DLockedAxis', 'measure2DMode', 'measure2DResults',
  'measure2DShiftLocked', 'measure2DSnapPoint', 'measure2DStart', 'meshColorBackup',
  'metadataProgress', 'models', 'mutationVersion', 'mutationViews', 'overridesEnabled',
  'overridesPanelVisible', 'pendingColorUpdates', 'pendingInstancedShards',
  'pendingMeshColorUpdates', 'pendingPropertyFocus', 'pinboardEntities', 'playbackIsPlaying',
  'playbackTime', 'pointCloudAlignmentAvailable', 'pointCloudAlignmentEnabled',
  'pointCloudAssetCount', 'pointCloudClassCounts', 'pointCloudClassMask',
  'pointCloudColorMode', 'pointCloudDeviationCenterOffset', 'pointCloudDeviationComputed',
  'pointCloudDeviationHalfRange', 'pointCloudEdlEnabled', 'pointCloudEdlStrength',
  'pointCloudFixedColor', 'pointCloudPointSize', 'pointCloudPreviewStride',
  'pointCloudRoundShape', 'pointCloudSizeMode', 'pointCloudWorldRadius', 'polygonArea2DPoints',
  'polygonArea2DResults', 'progress', 'projectionMode', 'redoStacks', 'scheduleData',
  'scheduleRange', 'scriptAssistantTurnSnapshot', 'scriptDeleteConfirmId',
  'scriptExecutionState', 'scriptLastDiagnostics', 'scriptLastError', 'scriptLastResult',
  'searchFieldFilter', 'searchFilter', 'searchFilterError', 'searchFilterResult',
  'searchFilterRunning', 'searchFilterSchema', 'searchHighlightIndex', 'searchIndexes',
  'searchModalOpen', 'searchModelFilter', 'searchOpen', 'searchQuery', 'searchVimCycle',
  'sectionPlane', 'selectedAnnotation2D', 'selectedAnnotationId', 'selectedEntities',
  'selectedEntitiesSet', 'selectedEntity', 'selectedEntityId', 'selectedEntityIds',
  'selectedModelId', 'selectedStoreys', 'selectedTaskGlobalIds', 'separationLinesEnabled',
  'separationLinesIntensity', 'separationLinesQuality', 'separationLinesRadius',
  'sheetEnabled', 'sheetPanelVisible', 'suppressNextSection2DPanelAutoOpen',
  'textAnnotation2DEditing', 'textAnnotations2D', 'titleBlockEditorVisible', 'typeViewMode',
  'typeVisibility', 'undoStacks', 'visualEnhancementsEnabled', 'zoneApportionment',
  'zoneAssignmentTiming', 'zoneAssignments',
];


/** A `SliceTeardown` by shape, without importing the type into a runtime check. */
function isSliceTeardown(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { slice?: unknown; owns?: unknown; teardown?: unknown };
  return typeof v.slice === 'string' && Array.isArray(v.owns) && typeof v.teardown === 'function';
}

/**
 * The two failures `createTeardownRegistry` cannot see.
 *
 * It proves ownership is DISJOINT — no two slices claim one key — and throws on
 * import when they do. It proves nothing about COMPLETENESS, and completeness
 * is the half with no smell: a key that stops being torn down does not throw,
 * does not fail to compile, and does not fail any existing test. It just stops
 * being cleared, which is the exact defect this seam was built to remove.
 *
 * The pins fail in BOTH directions. A key leaving means something stopped being
 * torn down; a key arriving means a slice started destroying state it did not
 * before, which is Trap A and the class `check-whole-state-reset.mjs` records as
 * three real shipped bugs. Neither direction throws, fails to compile, or
 * breaks another test on its own.
 *
 * Ways to lose or gain a key silently:
 *
 *   1. drop the key from a teardown's BODY while leaving it in `owns` — this
 *      compiles, because `Partial<Pick<...>>` does not require the key,
 *   2. drop it from `owns`,
 *   3. write the whole contribution and forget the registry import line.
 *
 * `teardownOwnedKeys` was exported for the first of these and nothing called
 * it, so the guard read as coverage while asserting nothing.
 */
describe('the teardown registry stays complete', () => {
  it('still WRITES every key it wrote when this was pinned, which an `owns`-only pin does not check', () => {
    // Run the registry, do not read its declarations. A body that stops
    // emitting a key type-checks clean and keeps its `owns` entry, so this is
    // the only place that failure shows up.
    const emitted = (kind: 'session-reset' | 'all-models-cleared'): string[] => {
      const keys = new Set<string>();
      for (const entry of viewerTeardownRegistry) {
        for (const key of Object.keys(entry.teardown({ kind }, {}))) keys.add(String(key));
      }
      return [...keys].sort();
    };

    for (const [kind, pinned] of [
      ['session-reset', PINNED_SESSION_RESET_KEYS],
      ['all-models-cleared', PINNED_ALL_MODELS_CLEARED_KEYS],
    ] as const) {
      const actual = emitted(kind);
      const dropped = pinned.filter((key) => !actual.includes(key));
      assert.deepStrictEqual(
        dropped,
        [],
        `${kind} used to write these keys and does not any more: ${dropped.join(', ')}`,
      );
      // Fails too, and that is the point. An `added` key is Trap A: the slice
      // now destroys something it did not before. `check-whole-state-reset.mjs`
      // records three of those shipping in one day - sheetSlice.clearSheet
      // wiping savedSheetTemplates, drawing2DSlice.clearDrawing2D wiping
      // override rules, DXF underlays and text annotations. Ownership stays
      // disjoint through all of them, so the registry does not throw and the
      // body type-checks. A one-directional pin would pass.
      const added = actual.filter((key) => !pinned.includes(key));
      assert.deepStrictEqual(
        added,
        [],
        `${kind} now writes keys it did not before: ${added.join(', ')}. If that is intended, ` +
          'add them to the pinned list IN THE SAME COMMIT so the widening is reviewable. If it is ' +
          'not, some slice just started destroying state it does not own.',
      );
    }
  });

  it('declares the same ownership it declared when this was pinned', () => {
    const owned = teardownOwnedKeys(viewerTeardownRegistry);
    const actual = [...owned.keys()].map(String).sort();

    const dropped = PINNED_OWNED_KEYS.filter((key) => !actual.includes(key));
    assert.deepStrictEqual(
      dropped,
      [],
      `these keys were declared owned when this was pinned and are not any more: ${dropped.join(', ')}`,
    );

    // Same both-directions rule as the emission pin above.
    const added = actual.filter((key) => !PINNED_OWNED_KEYS.includes(key));
    assert.deepStrictEqual(
      added,
      [],
      `these keys are newly declared owned: ${added.join(', ')}. Widening what a slice is willing ` +
        'to destroy is a deliberate act; add them to PINNED_OWNED_KEYS in the same commit.',
    );
  });

  it('registers every teardown a slice exports, so a contribution cannot be written and then left out of the registry', async () => {
    // Import every slice module and look at the VALUES it exports. Reading the
    // directory is a filesystem question ("what slices exist"); reading their
    // source text and grepping it would be the banned kind of assertion, and
    // would also be weaker — this compares object identity against the
    // registry's own contents, so a teardown renamed, re-exported or shadowed
    // still has to be the same object the registry holds.
    const slicesDir = join(HERE, 'slices');
    const registered = new Set<unknown>(viewerTeardownRegistry);
    const found: string[] = [];
    const missing: string[] = [];

    for (const file of readdirSync(slicesDir).sort()) {
      if (!file.endsWith('.ts') || file.includes('.test.')) continue;
      const mod = (await import(join(slicesDir, file))) as Record<string, unknown>;
      for (const [name, value] of Object.entries(mod)) {
        if (!isSliceTeardown(value)) continue;
        found.push(`${file}:${name}`);
        if (!registered.has(value)) missing.push(`${file}:${name}`);
      }
    }

    assert.deepStrictEqual(
      missing,
      [],
      `these teardowns exist but are not in viewerTeardownRegistry, so their slices are never torn down: ${missing.join(', ')}`,
    );

    // Non-vacuity: the sweep must actually find the contributions. Without this
    // an import that stopped resolving would report "nothing missing" forever.
    assert.ok(
      found.length >= 20,
      `expected the slices directory to yield at least 20 teardowns, found ${found.length} — the sweep is broken, not the registry`,
    );
    assert.strictEqual(
      viewerTeardownRegistry.length,
      found.length,
      'the registry holds a different number of entries than the slices directory exports',
    );
  });
});
