/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * The Cesium / geo-basemap catalogue (#4918 slice: cesiumgeo) covers the
 * five files owning the geospatial-basemap feature area:
 * `CesiumPlacementEditor.tsx` (the drag-to-move georeference gizmo and its
 * floating panel — deltas, nudge/rotate controls, the map-absolute
 * guard warning, and the apply/reset actions), `CustomBasemapEditor.tsx`
 * and `CustomTilesetEditor.tsx` (the custom XYZ-tile and 3D-Tiles input
 * surfaces under the Sun & Sky panel's Base map selector, including their
 * third-party-privacy disclosures), `CesiumOverlay.tsx` (the globe's own
 * loading/error/basemap-warning banners), and `AxisHelper.tsx` (the 3D
 * axis-triad labels). `Eastings`, `Northings`, and `OrthogonalHeight` are
 * exact `IfcMapConversion` EXPRESS attribute names used as field labels —
 * same house rule `GeoreferencingPanel.tsx`'s `GorefRow` labels already
 * follow — and stay literal wherever they appear as a bare label; a full
 * sentence that happens to mention one (a drag-gizmo tooltip, the panel's
 * usage hint) is still one catalogued message. `Delta E/N/Z/R` and `XAxis
 * angle` are UI-chosen abbreviations, not schema spelling, so they are
 * catalogued. The nudge-button glyphs (`N+`, `E-`, `Z+`, `R-`, …) and the
 * axis-triad's `X`/`Y`/`Z` letters are catalogued too even though a
 * translator is expected to leave them unchanged, the same reasoning the
 * WebGPU-troubleshooting catalogue documents for browser flag names. The
 * `Remove` button shared verbatim by the basemap and tileset editors uses
 * one `cesiumGeo.shared.*` key rather than two copies, the same pattern the
 * BCF-panel catalogue's `bcf.shared.*` prefix uses. Basemap/tileset URLs
 * the user has actually saved are runtime data; the example URLs shown as
 * field placeholders are this slice's own copy and are catalogued like any
 * other placeholder.
 */
export const cesiumGeoEn = {
  // CesiumPlacementEditor
  'cesiumGeo.placement.headerTitle': 'Move Georef',
  'cesiumGeo.placement.headerAriaLabel': 'Move georeference panel header',
  'cesiumGeo.placement.unsavedChanges': 'Unsaved changes',
  'cesiumGeo.placement.expandPanel': 'Expand panel',
  'cesiumGeo.placement.collapsePanel': 'Collapse panel',
  'cesiumGeo.placement.closeAriaLabel': 'Close georeference move mode',
  'cesiumGeo.placement.dragPlaneTitle': 'Drag to move Eastings/Northings',
  'cesiumGeo.placement.dragHeightTitle': 'Drag to change OrthogonalHeight',
  'cesiumGeo.placement.dragXYLabel': 'DRAG XY',
  'cesiumGeo.placement.dragPlaneAriaLabel': 'Drag Eastings and Northings',
  'cesiumGeo.placement.dragHeightAriaLabel': 'Drag OrthogonalHeight',
  'cesiumGeo.placement.deltaELabel': 'Delta E',
  'cesiumGeo.placement.deltaNLabel': 'Delta N',
  'cesiumGeo.placement.deltaZLabel': 'Delta Z',
  'cesiumGeo.placement.deltaRLabel': 'Delta R',
  'cesiumGeo.placement.xAxisAngleLabel': 'XAxis angle',
  'cesiumGeo.placement.mapAbsoluteWarning':
    "This model's geometry already sits at its declared map anchor. Small XY drags inside ~10 km of the anchor have no visible effect (the guard keeps neutralising it) — use the map-pick tool to relocate it in one step instead.",
  'cesiumGeo.placement.dragHint': 'Drag the pad on the model to move Eastings/Northings. Drag the knob to change height.',
  'cesiumGeo.placement.nudgeOneMeter': 'Nudge 1 m',
  'cesiumGeo.placement.nudgeNorthAriaLabel': 'Nudge north',
  'cesiumGeo.placement.nudgeNorthLabel': 'N+',
  'cesiumGeo.placement.nudgeWestAriaLabel': 'Nudge west',
  'cesiumGeo.placement.nudgeWestLabel': 'E-',
  'cesiumGeo.placement.nudgeEastAriaLabel': 'Nudge east',
  'cesiumGeo.placement.nudgeEastLabel': 'E+',
  'cesiumGeo.placement.nudgeSouthAriaLabel': 'Nudge south',
  'cesiumGeo.placement.nudgeSouthLabel': 'N-',
  'cesiumGeo.placement.heightLabel': 'Height',
  'cesiumGeo.placement.nudgeHeightDownAriaLabel': 'Nudge height down',
  'cesiumGeo.placement.nudgeHeightDownLabel': 'Z-',
  'cesiumGeo.placement.nudgeHeightUpAriaLabel': 'Nudge height up',
  'cesiumGeo.placement.nudgeHeightUpLabel': 'Z+',
  'cesiumGeo.placement.rotateLabel': 'Rotate',
  'cesiumGeo.placement.rotateNegAriaLabel': 'Rotate negative one degree',
  'cesiumGeo.placement.rotateNegLabel': 'R-',
  'cesiumGeo.placement.rotatePosAriaLabel': 'Rotate positive one degree',
  'cesiumGeo.placement.rotatePosLabel': 'R+',
  'cesiumGeo.placement.applyButton': 'Set as georeference',
  'cesiumGeo.placement.resetButton': 'Reset',
  'cesiumGeo.placement.toastApplied': 'Georeference placement updated',

  // CustomBasemapEditor
  'cesiumGeo.basemap.urlLabel': 'Tile URL template',
  'cesiumGeo.basemap.urlPlaceholder': 'https://example.org/tiles/{z}/{x}/{y}.png',
  'cesiumGeo.basemap.attributionLabel': 'Attribution (required)',
  'cesiumGeo.basemap.attributionAriaLabel': 'Attribution',
  'cesiumGeo.basemap.attributionPlaceholder': 'Imagery © provider, CC BY 4.0',
  'cesiumGeo.basemap.attributionLinkLabel': 'Attribution link',
  'cesiumGeo.basemap.attributionLinkPlaceholder': 'https://…/licence',
  'cesiumGeo.basemap.maxZoomLabel': 'Max zoom',
  'cesiumGeo.basemap.maxZoomAriaLabel': 'Maximum zoom',
  'cesiumGeo.basemap.privacyNote': 'Tiles are requested straight from this server, so it sees where you pan and zoom.',
  'cesiumGeo.basemap.checkingButton': 'Checking…',
  'cesiumGeo.basemap.saveButton': 'Save basemap',
  'cesiumGeo.basemap.okStatus': 'Saved. This server allows browser access.',

  // CustomTilesetEditor
  'cesiumGeo.tileset.urlLabel': '3D Tiles URL',
  'cesiumGeo.tileset.urlPlaceholder': 'https://example.org/tileset.json',
  'cesiumGeo.tileset.privacyNote': 'The tileset is requested straight from this server, so it sees where you pan and zoom.',
  'cesiumGeo.tileset.saveButton': 'Save tileset',

  // Shared between CustomBasemapEditor and CustomTilesetEditor
  'cesiumGeo.shared.removeButton': 'Remove',

  // CesiumOverlay
  'cesiumGeo.overlay.loadingLabel': 'Loading 3D context...',
  'cesiumGeo.overlay.noCustomBasemapWarning': 'No custom basemap is configured. Add a tile URL in Sun & Sky > Base map.',
  'cesiumGeo.overlay.customBasemapUnavailable': 'That tile URL could not be used as a basemap.',
  'cesiumGeo.overlay.noCustomTilesetWarning': 'No custom 3D Tiles URL is configured. Add one in Sun & Sky > Base map.',
  'cesiumGeo.overlay.initFailed': 'Cesium initialization failed',

  // AxisHelper
  'cesiumGeo.axisHelper.labelX': 'X',
  'cesiumGeo.axisHelper.labelY': 'Y',
  'cesiumGeo.axisHelper.labelZ': 'Z',
} as const satisfies Record<string, TranslationValue>;
