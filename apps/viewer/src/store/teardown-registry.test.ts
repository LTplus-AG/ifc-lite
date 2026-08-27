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
 * Every key the registry tore down when this was pinned.
 *
 * Update deliberately, never to make a red test green: a key LEAVING this list
 * means some slice stopped tearing it down, which is the bug. A key joining it
 * is normal as slices gain fields, and the test logs those rather than failing.
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
 * Two ways to lose a key silently, one test each:
 *
 *   1. drop it from a slice's `owns` (or from the body, since `owns` and the
 *      emitted keys are only equal by hand),
 *   2. write the whole contribution and forget the registry import line.
 *
 * `teardownOwnedKeys` was exported for the first of these and nothing called
 * it, so the guard read as coverage while asserting nothing.
 */
describe('the teardown registry stays complete', () => {
  it('owns exactly the keys it owned when this was pinned, so a key dropped from an `owns` list cannot go unnoticed', () => {
    const owned = teardownOwnedKeys(viewerTeardownRegistry);
    const actual = [...owned.keys()].map(String).sort();

    const dropped = PINNED_OWNED_KEYS.filter((key) => !actual.includes(key));
    assert.deepStrictEqual(
      dropped,
      [],
      `these keys were torn down when this was pinned and are not any more: ${dropped.join(', ')}`,
    );

    const added = actual.filter((key) => !PINNED_OWNED_KEYS.includes(key));
    if (added.length > 0) {
      console.log('new keys now torn down (update teardown-owned-keys.json):', added);
    }
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
