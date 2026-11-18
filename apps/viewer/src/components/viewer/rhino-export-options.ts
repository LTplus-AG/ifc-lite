/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What the Rhino (.3dm) dialog's fields mean to the scene builder, split out
 * of `RhinoExportDialog.tsx` so the mapping is testable without React.
 *
 * Defaults follow the spec's Options table (`docs/architecture/rhino-3dm-export.md`):
 * the dialog sends only fields the user can see, and everything else
 * (`normals`, `layerSlicing`) keeps the Rust default.
 */

import { RHINO_SCENE_DEFAULTS, type RhinoSceneExportOptions } from '@ifc-lite/geometry';
import { resolveExportVisibility } from '@/store/exportVisibility';
import type { useViewerStore } from '@/store';

type ViewerState = ReturnType<typeof useViewerStore.getState>;

export type RhinoUnits = NonNullable<RhinoSceneExportOptions['units']>;
export type RhinoLayerScheme = NonNullable<RhinoSceneExportOptions['layerScheme']>;
export type RhinoProperties = NonNullable<RhinoSceneExportOptions['properties']>;
export type RhinoCoordinates = NonNullable<RhinoSceneExportOptions['coordinates']>;
export { RHINO_UNITS, RHINO_COORDINATES, RHINO_LAYER_SCHEMES, RHINO_PROPERTIES } from '@ifc-lite/geometry';
import { RHINO_3DM_VERSIONS, type Rhino3dmVersion } from '@ifc-lite/rhino3dm';
export { RHINO_3DM_VERSIONS, type Rhino3dmVersion };

/** The dialog's own fields. */
export type RhinoExportSettings = Required<Pick<RhinoSceneExportOptions,
  'units' | 'layerScheme' | 'instancing' | 'properties' | 'includeSpaces' | 'coordinates'
>> & { visibleOnly: boolean; version: Rhino3dmVersion };

export const DEFAULT_RHINO_EXPORT_SETTINGS: RhinoExportSettings = {
  units: RHINO_SCENE_DEFAULTS.units,
  coordinates: RHINO_SCENE_DEFAULTS.coordinates,
  layerScheme: RHINO_SCENE_DEFAULTS.layerScheme,
  instancing: RHINO_SCENE_DEFAULTS.instancing,
  properties: RHINO_SCENE_DEFAULTS.properties,
  includeSpaces: RHINO_SCENE_DEFAULTS.includeSpaces,
  visibleOnly: false, version: RHINO_3DM_VERSIONS[0],
};

/** The viewer's visibility for one model, in the scene builder's terms. */
export type RhinoVisibilityFilter = Required<Pick<RhinoSceneExportOptions, 'hidden' | 'isolated'>>;

/** Read the viewer's current visibility for `modelId` through the shared
 *  export resolver (hide, lens, class toggles, storey, class filter, isolate). */
export function resolveRhinoVisibility(state: ViewerState, modelId: string): RhinoVisibilityFilter {
  const { hiddenLocalIds, isolatedLocalIds } = resolveExportVisibility(state, modelId);
  return {
    hidden: [...hiddenLocalIds],
    isolated: isolatedLocalIds === null ? null : [...isolatedLocalIds],
  };
}

/** The scene builder's options for these settings. `visibility` is read only
 *  when `visibleOnly` is on. */
export function rhinoSceneOptions(
  settings: RhinoExportSettings,
  visibility?: RhinoVisibilityFilter,
): RhinoSceneExportOptions {
  const { visibleOnly, version: _version, ...options } = settings;
  return { ...options, ...(visibleOnly ? visibility : {}) };
}
