/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Add the selected built-in 3D context tileset to the Cesium viewer. Returns
 * the created tileset so callers can toggle its shadow casting/receiving for
 * solar studies (`null` if none could be created).
 *
 * Flat imagery bases (`osm-map`, `custom`) and the user-supplied
 * `custom-3dtiles` source are NOT handled here: they are loaded inline in
 * `CesiumOverlay`'s init effect, where a failure can be surfaced as a visible
 * `basemapWarning` rather than swallowed by this function's catch-all. This
 * function owns only the three sources whose failure is non-fatal-by-design
 * (a missing tileset here silently leaves the globe alone, which is the
 * existing, accepted behaviour for OSM Buildings / Google Photorealistic).
 */
export async function addDataSourceLayer(
  Cesium: typeof import('cesium'),
  viewer: InstanceType<typeof import('cesium').Viewer>,
  dataSource: string,
  ionToken: string,
): Promise<InstanceType<typeof import('cesium').Cesium3DTileset> | null> {
  try {
    switch (dataSource) {
      case 'osm-map':
      case 'custom':
      case 'custom-3dtiles': {
        // Handled inline in Effect 1 (imagery-only sources have no tileset;
        // custom-3dtiles needs the URL + warning wiring that only the
        // component has). Kept explicit so a future refactor that drops the
        // caller's guard fails visibly instead of falling through to the
        // photorealistic default below.
        return null;
      }
      case 'osm-buildings': {
        // OpenStreetMap Buildings — flat-shaded extruded footprints, the grey
        // massing context used for sun-path / overshadowing studies.
        const tileset = await Cesium.createOsmBuildingsAsync();
        viewer.scene.primitives.add(tileset);
        return tileset;
      }
      case 'google-photorealistic':
      default: {
        try {
          const tileset = await Cesium.createGooglePhotorealistic3DTileset();
          viewer.scene.primitives.add(tileset);
          return tileset;
        } catch {
          if (ionToken) {
            const tileset = await Cesium.Cesium3DTileset.fromIonAssetId(2275207);
            viewer.scene.primitives.add(tileset);
            return tileset;
          }
          return null;
        }
      }
    }
  } catch (err) {
    console.warn('[CesiumOverlay] Failed to add data source:', dataSource, err);
    return null;
  }
}
