/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * The command lists both the classic `MainToolbar` and the ribbon render
 * from a single registry, so neither style can host a command the other
 * lacks (#4918 slice 2, following slice 1's `main-toolbar.en.ts`):
 * - `export-commands.ts` — `ClassicExportMenuItems` / `RibbonExportGroup`
 * - `camera-commands.ts` — `CameraCommandMenuItems` / `ViewTab`
 * - `bottom-panels.ts` consumer `BottomPanelMenuItems`
 * - `AuthorPanelMenuItems`
 * - `ClassVisibilityMenu` (`ClassVisibilityMenuContent`)
 *
 * The two data-only registries (`export-commands.ts`, `camera-commands.ts`)
 * are plain arrays with no React import, so they carry a translation KEY per
 * row rather than calling `t()` themselves — the same pattern
 * `sectionConstants.ts`'s `AXIS_INFO` uses. Renderers call `t(row.xKey)`.
 * IFC EXPRESS names and single-letter/number keyboard shortcuts stay literal.
 */
export const sharedCommandsEn = {
  'exportCommands.ifc.label': 'IFC',
  'exportCommands.ifc.menuLabel': 'Export IFC (with changes)',
  'exportCommands.ifc.tooltip': 'Export IFC (with changes)',

  'exportCommands.anonymized.label': 'Anonymized',
  'exportCommands.anonymized.menuLabel': 'Export anonymized subset (selection)',
  'exportCommands.anonymized.tooltip': 'Export selected objects as an anonymized IFC',

  'exportCommands.glb.label': 'GLB',
  'exportCommands.glb.menuLabel': 'Export GLB (3D Model)',
  'exportCommands.glb.tooltip': 'Export GLB (3D model)',

  'exportCommands.kmz.label': 'KMZ',
  'exportCommands.kmz.menuLabel': 'Export KMZ (Google Earth Pro)',
  'exportCommands.kmz.tooltip': 'Export KMZ (Google Earth Pro)',

  'exportCommands.usd.label': 'USD',
  'exportCommands.usd.menuLabel': 'Export USD (OpenUSD)',
  'exportCommands.usd.tooltip': 'Export USD (OpenUSD .usda)',

  'exportCommands.energy.label': 'Energy',
  'exportCommands.energy.menuLabel': 'Energy Model (HBJSON / DFJSON)',
  'exportCommands.energy.tooltip': 'Export energy model (HBJSON / DFJSON)',

  'exportCommands.csv.label': 'CSV',
  'exportCommands.csv.menuLabel': 'Export CSV',
  'exportCommands.csv.tooltip': 'Export CSV tables',
  'exportCommands.csv.item.entities': 'Entities',
  'exportCommands.csv.item.properties': 'Properties',
  'exportCommands.csv.item.quantities': 'Quantities',
  'exportCommands.csv.item.spatial': 'Spatial Hierarchy',

  'exportCommands.json.label': 'JSON',
  'exportCommands.json.menuLabel': 'Export JSON (active model)',
  'exportCommands.json.tooltip': 'Export the active model as JSON',

  'exportCommands.screenshot.label': 'Screenshot',
  'exportCommands.screenshot.menuLabel': 'Screenshot',
  'exportCommands.screenshot.tooltip': 'Save viewport as PNG',

  'exportCommands.pdf.label': 'PDF',
  'exportCommands.pdf.menuLabel': 'Export PDF (to-scale 3D view)',
  'exportCommands.pdf.tooltip': 'Export PDF (to-scale 3D view)',

  'exportCommands.modifiedIfc.label': 'Modified IFC',
  'exportCommands.modifiedIfc.menuLabel': 'Export modified IFC…',
  'exportCommands.modifiedIfc.tooltip': 'Export every model with unexported edits, edits applied',

  // Extension-contributed exporters: the row text is the exporter's own name.
  'exportCommands.extension.groupLabel': 'From extensions',
  'exportCommands.extension.exportedToast': 'Exported with {name}',
  'exportCommands.extension.failedToast': '"{name}" failed: {error}',

  'cameraCommands.group.camera': 'Camera',
  'cameraCommands.group.preset': 'Preset views',
  'cameraCommands.group.rotate': 'Rotate',

  'cameraCommands.home.label': 'Isometric',
  'cameraCommands.home.tooltip': 'Home (isometric + reset visibility)',
  'cameraCommands.zoomIn.label': 'Zoom in',
  'cameraCommands.zoomIn.tooltip': 'Zoom in',
  'cameraCommands.zoomOut.label': 'Zoom out',
  'cameraCommands.zoomOut.tooltip': 'Zoom out',
  'cameraCommands.fitAll.label': 'Fit all',
  'cameraCommands.fitAll.tooltip': 'Fit all in view',
  'cameraCommands.viewTop.label': 'Top',
  'cameraCommands.viewTop.tooltip': 'Top view',
  'cameraCommands.viewBottom.label': 'Bottom',
  'cameraCommands.viewBottom.tooltip': 'Bottom view',
  'cameraCommands.viewFront.label': 'Front',
  'cameraCommands.viewFront.tooltip': 'Front view',
  'cameraCommands.viewBack.label': 'Back',
  'cameraCommands.viewBack.tooltip': 'Back view',
  'cameraCommands.viewLeft.label': 'Left',
  'cameraCommands.viewLeft.tooltip': 'Left view',
  'cameraCommands.viewRight.label': 'Right',
  'cameraCommands.viewRight.tooltip': 'Right view',
  'cameraCommands.rotateLeft.label': 'Rotate left',
  'cameraCommands.rotateLeft.tooltip': 'Rotate left 90°',
  'cameraCommands.rotateRight.label': 'Rotate right',
  'cameraCommands.rotateRight.tooltip': 'Rotate right 90°',

  'workspacePanels.workspaceLabel': 'Workspace',
  'workspacePanels.bottom.script': 'Script Editor',
  'workspacePanels.bottom.lists': 'Lists',
  'workspacePanels.bottom.gantt': 'Schedule (Gantt)',
  'workspacePanels.bottom.charts': 'Charts',
  'workspacePanels.bottom.flow': 'Flow',
  'workspacePanels.bottom.drawing': 'Drawing',
  'workspacePanels.bottom.document': 'Document',

  'workspacePanels.authorLabel': 'Author',
  'workspacePanels.author.appearance': 'Appearance',
  'workspacePanels.author.addElement': 'Add Element',
  'workspacePanels.author.extensions': 'Extensions',

  'classVisibility.viewHeading': '3D View',
  'classVisibility.viewModeAriaLabel': '3D view mode',
  'classVisibility.modelMode': 'Model',
  'classVisibility.typesMode': 'Types',
  'classVisibility.heading': 'Visibility',
  'classVisibility.reset': 'Reset',

  'classVisibility.spaces.label': 'Spaces',
  'classVisibility.spaces.description': 'Room volumes (IfcSpace)',
  'classVisibility.spatialZones.label': 'Spatial Zones',
  'classVisibility.spatialZones.description': 'Gross-area volumes (IfcSpatialZone)',
  'classVisibility.openings.label': 'Openings',
  'classVisibility.openings.description': 'Door & window voids',
  'classVisibility.virtualElements.label': 'Virtual Elements',
  'classVisibility.virtualElements.description': 'Non-physical boundaries & clearance volumes',
  'classVisibility.site.label': 'Site',
  'classVisibility.site.description': 'Terrain & context',
  'classVisibility.annotations.label': 'Annotations',
  'classVisibility.annotations.description': 'Text, dimensions, leaders',
  'classVisibility.grids.label': 'Grids',
  'classVisibility.grids.description': 'Structural axes',

  'classVisibility.mergeLayers.label': 'Merge multilayer walls',
  'classVisibility.mergeLayers.description': 'Render walls as one solid · on reload',

  'classVisibility.fastGeometry.label': 'Fast geometry',
  'classVisibility.fastGeometry.descriptionFast': 'Skip tiny cuts, auto-detail · on reload',
  'classVisibility.fastGeometry.descriptionExact': 'Exact: full cuts + density · on reload',

  'classVisibility.pinnedDetail.label': 'Detail pinned: {tier}',
  'classVisibility.pinnedDetail.descriptionIgnored': 'Ignored in Exact · manage in Performance settings',
  'classVisibility.pinnedDetail.descriptionOverrides': 'Overrides automatic detail · manage in Performance settings',
  'classVisibility.performanceSettings': 'Performance settings',
} as const satisfies Record<string, TranslationValue>;
