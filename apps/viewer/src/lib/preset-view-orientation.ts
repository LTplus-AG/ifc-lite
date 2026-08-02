/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export type PresetView = 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right';

/**
 * Y-axis rotation to hand `Camera.setPresetView` for a preset view.
 *
 * By default the presets align to the building's local axes via the IfcSite
 * placement rotation (`buildingRotation`): a site rotated relative to the grid
 * still shows "straight", the floor-plan / drawing convention. But the Cesium
 * world-context basemap is a map, where TOP/BOTTOM are expected to read
 * north-up. So when the basemap is active we drop `buildingRotation` for the
 * TOP/BOTTOM presets (rotation 0 = geographic north at the top of the screen),
 * while the side views still face the building's front. See issue #1532: a
 * model whose IfcSite is placed rotated ~180 degrees otherwise puts north at
 * the bottom of the world-context top view.
 *
 * `worldContextActive` should reflect a basemap that is actually rendering
 * (`cesiumEnabled && cesiumAvailable`), not just the toggle, so a stale
 * `cesiumEnabled` after georeferencing disappears does not force north-up.
 */
export function presetViewRotation(
  view: PresetView,
  buildingRotation: number | undefined,
  worldContextActive: boolean,
): number | undefined {
  if (worldContextActive && (view === 'top' || view === 'bottom')) {
    return 0;
  }
  return buildingRotation;
}
