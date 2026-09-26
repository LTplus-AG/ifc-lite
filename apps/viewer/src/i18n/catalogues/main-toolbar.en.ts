/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * The classic single-strip `MainToolbar` (#1686 predates the tabbed
 * ribbon; kept as an opt-in style). Covers the strip's own chrome: file
 * operations, the Panels/Edit/View-options menus' own labels, the tool
 * buttons, the selection action cluster, and the meta cluster (theme,
 * info). Labels that come from shared command surfaces the ribbon also
 * renders — camera commands (`CameraCommandMenuItems`), the export menu
 * (`ClassicExportMenuItems`), the workspace-panel toggle lists
 * (`BottomPanelMenuItems`, `AuthorPanelMenuItems`) and the class
 * visibility body (`ClassVisibilityMenuContent`) — are owned by those
 * shared modules, not this catalogue (#4918 slice 2).
 */
export const mainToolbarEn = {
  'mainToolbar.openAriaLabel': 'Open IFC file',
  'mainToolbar.openTooltip': 'Open IFC File',
  'mainToolbar.refreshModel': 'Refresh model from disk',
  'mainToolbar.refreshModels': 'Refresh models from disk',
  'mainToolbar.addModelAriaLabel': 'Add model to scene',
  'mainToolbar.addModelTooltip': 'Add Model to Scene (Multi-select supported)',
  'mainToolbar.exportAriaLabel': 'Export and download',
  'mainToolbar.editPropertiesAriaLabel': 'Edit properties',
  'mainToolbar.editPropertiesTooltip': 'Edit Properties',
  'mainToolbar.bulkPropertyEditor': 'Bulk Property Editor',
  'mainToolbar.importDataCsv': 'Import Data (CSV)',
  'mainToolbar.share': 'Share',
  'mainToolbar.room': 'Session',

  'mainToolbar.panels': 'Panels',
  'mainToolbar.panelsWithLabel': 'Panels: {label}',
  'mainToolbar.inspectValidate': 'Inspect & validate',
  'mainToolbar.bcfTopics': 'BCF Topics',
  'mainToolbar.idsValidation': 'IDS Validation',
  'mainToolbar.lensRules': 'Lens Rules',
  'mainToolbar.clashDetection': 'Clash Detection',
  'mainToolbar.compareModels': 'Compare Models',
  'mainToolbar.cloudSources': 'Cloud Sources',
  'mainToolbar.layerStack': 'Layer Stack',
  'mainToolbar.locationZones': 'Location Zones',
  'mainToolbar.loadReport': 'Load Report',
  'mainToolbar.cost': 'Cost',
  'mainToolbar.collaborationRoom': 'Collaboration Session',
  'mainToolbar.analysisExtensions': 'Analysis extensions',

  'mainToolbar.toolSelect': 'Select',
  'mainToolbar.toolWalk': 'Walk Mode',

  'mainToolbar.editModeEnterAriaLabel': 'Enter edit mode',
  'mainToolbar.editModeExitAriaLabel': 'Exit edit mode',
  'mainToolbar.editModeEnterTooltip': 'Edit Mode',
  'mainToolbar.editModeExitTooltip': 'Exit Edit Mode',
  'mainToolbar.editModeLocked': 'Editing requires editor access in this shared session',
  'mainToolbar.undo': 'Undo',
  'mainToolbar.redo': 'Redo',
  // Keyboard-shortcut hint letter next to the Edit mode toggle — a bare
  // single ASCII letter (no modifier glyph) doesn't qualify for the
  // sweep's own symbol-cluster allowlist, so it trips the gate like the
  // Measure catalogue's bare "m" unit symbol does.
  'mainToolbar.editModeShortcutHint': 'E',
  'mainToolbar.spaceSketch': 'Space Sketch',

  'mainToolbar.toolMeasure': 'Measure',
  'mainToolbar.toolSection': 'Section',
  'mainToolbar.toolAnnotate': 'Annotate',

  'mainToolbar.presentationShow': 'Show Presentation dock',
  'mainToolbar.presentationHide': 'Hide Presentation dock',
  'mainToolbar.presentationTooltip': 'Collection Presentation Dock (Views: {views}, Entities: {entities})',

  'mainToolbar.selectionActionsAriaLabel': 'Selection actions — {count} selected',
  'mainToolbar.selectionCountBadge': '{count} sel',
  'mainToolbar.isolateSelection': 'Isolate Selection (Set Collection)',
  'mainToolbar.hideSelection': 'Hide Selection',
  'mainToolbar.frameSelection': 'Frame Selection',
  'mainToolbar.showAll': 'Show All (Reset Filters)',
  'mainToolbar.fitAll': 'Fit All',

  'mainToolbar.visibility': 'Visibility',
  'mainToolbar.visibilityMerged': 'Visibility (Merge Multilayer Walls is on)',
  'mainToolbar.visibilityMergedTooltip': 'Visibility · Merge Multilayer Walls is on',

  'mainToolbar.home': 'Home (Isometric + Reset Visibility)',

  'mainToolbar.cesiumShow': 'Show 3D World Context (Cesium)',
  'mainToolbar.cesiumHide': 'Hide 3D World Context (Cesium)',
  'mainToolbar.moveGeorefAriaLabel': 'Move georeference in Cesium',
  'mainToolbar.moveGeorefStop': 'Stop moving georeference',
  'mainToolbar.moveGeorefTooltip': 'Move georeference',

  'mainToolbar.sunSkyOpen': 'Open Sun & Sky panel',
  'mainToolbar.sunSkyClose': 'Close Sun & Sky panel',
  'mainToolbar.sunSkyTooltip': 'Sun & sky',

  'mainToolbar.spaceMouseOpen': 'SpaceMouse settings',
  'mainToolbar.spaceMouseTooltip': 'SpaceMouse',

  'mainToolbar.viewOptions': 'View options',
  'mainToolbar.projection': 'Projection',
  'mainToolbar.orthographic': 'Orthographic',
  'mainToolbar.helpers': 'Helpers',
  'mainToolbar.hoverTooltips': 'Hover tooltips',
  'mainToolbar.openSettings': 'Settings…',
  'mainToolbar.toolbarLabel': 'Toolbar',
  'mainToolbar.ribbonToolbarMenuItem': 'Ribbon toolbar',

  'mainToolbar.themeTooltip': 'Toggle theme (Shift+click for secret mode)',
  'mainToolbar.infoAriaLabel': 'Info and keyboard shortcuts',
  'mainToolbar.infoTooltip': 'Info (?)',
} as const satisfies Record<string, TranslationValue>;
