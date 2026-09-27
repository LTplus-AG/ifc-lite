/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Geometry export dialogs catalogue (#4918 slice: geometry export). Covers
 * five sibling export-dialog components that each own a single "Export as
 * <format>" dialog: `GLBExportDialog.tsx` (`geometryExport.glb.*`),
 * `KmzExportDialog.tsx` (`geometryExport.kmz.*`), `UsdExportDialog.tsx`
 * (`geometryExport.usd.*`), `EnergyModelExportDialog.tsx`
 * (`geometryExport.energy.*`), and the Properties panel's inline
 * `GeometryEditCard.tsx` (`geometryExport.editCard.*` — grouped here rather
 * than its own file purely because it is a small slice sibling, not because
 * it shares any export machinery with the four dialogs above). File format
 * names (GLB, glTF, KMZ, COLLADA, USD, USDA, OpenUSD, HBJSON, DFJSON,
 * Honeybee, Dragonfly, Ladybug Tools), IFC EXPRESS names (`IfcSurfaceStyle
 * Rendering`, `DiffuseColour`, `SurfaceColour`, `IfcMapConversion`,
 * `IfcSpace`, `IfcWall`, `OrthogonalHeight`), and axis/unit symbols (X, Y, Z,
 * m, °) stay literal per the house rule. Runtime error detail forwarded from
 * a thrown `Error`'s own `.message` is interpolated as a parameter, never
 * translated itself — it is engine/library content, not UI chrome.
 */
import type { TranslationValue } from '../types';

export const geometryExportDialogsEn = {
  // --- shared across GLBExportDialog.tsx / KmzExportDialog.tsx ---
  'geometryExport.shared.currentModelFallbackName': 'Current Model',
  'geometryExport.shared.unknownError': 'Unknown error',
  'geometryExport.shared.geometryEngineUnavailableError': 'Geometry engine unavailable',

  // --- ExportDialogShell.tsx (#5848) ---
  'geometryExport.shell.filenamePreviewLabel': 'Will save as:',

  // --- GLBExportDialog.tsx ---
  'geometryExport.glb.triggerButton': 'Export GLB',
  'geometryExport.glb.dialogTitle': 'Export GLB File',
  'geometryExport.glb.dialogDescription':
    'Export model geometry as binary glTF, including its current workspace placement',
  'geometryExport.glb.modelLabel': 'Model',
  'geometryExport.glb.selectModelPlaceholder': 'Select model',
  'geometryExport.glb.colorSourceLabel': 'Colour Source',
  'geometryExport.glb.colorSourceRendering': 'Rendering (apparent colour)',
  'geometryExport.glb.colorSourceShading': 'Shading (SurfaceColour)',
  'geometryExport.glb.colorSourceRenderingHint':
    'Uses IfcSurfaceStyleRendering.DiffuseColour when authored, otherwise SurfaceColour. Matches most IFC viewers.',
  'geometryExport.glb.colorSourceShadingHint':
    'Uses the base SurfaceColour. Falls back to the rendering colour when no distinct DiffuseColour was authored.',
  'geometryExport.glb.outputLabel': 'Output',
  'geometryExport.glb.outputFormat': 'glTF Binary',
  'geometryExport.glb.fileExtension': '.glb',
  'geometryExport.glb.visibleOnlyLabel': 'Export Visible Only',
  'geometryExport.glb.visibleOnlyHint': 'Skip entities currently hidden or outside the isolation set',
  'geometryExport.glb.includeMetadataLabel': 'Include Metadata',
  'geometryExport.glb.includeMetadataHint': 'Embed expressId / modelIndex on each node and totals on the asset',
  'geometryExport.glb.litLabel': 'Lit Materials',
  'geometryExport.glb.litHint': 'Shade from normals in other viewers. Off = flat apparent colour (unlit)',
  'geometryExport.glb.successTitle': 'Success',
  'geometryExport.glb.errorTitle': 'Error',
  'geometryExport.glb.exportedMessage': 'Exported GLB ({sizeKb} KB)',
  'geometryExport.glb.noRenderGeometryError':
    'GLB export produced 0 meshes — nothing visible to export with the current filters.',
  'geometryExport.glb.failedMessage': 'GLB export failed: {reason}',
  'geometryExport.glb.cancelButton': 'Cancel',
  'geometryExport.glb.exportingButton': 'Exporting...',
  'geometryExport.glb.exportButton': 'Export',

  // --- KmzExportDialog.tsx ---
  'geometryExport.kmz.triggerButton': 'Export KMZ',
  'geometryExport.kmz.dialogTitle': 'Export KMZ for Google Earth Pro',
  'geometryExport.kmz.dialogDescription':
    'Places the model at its real-world location, embedded as COLLADA. Requires a georeferenced model.',
  'geometryExport.kmz.notGeoreferencedError':
    'This model has no georeferencing (IfcMapConversion / projected CRS), so it has no real-world location to place in Google Earth. Add a location in the Georeferencing panel first.',
  'geometryExport.kmz.unprojectableError':
    'The model is georeferenced but its coordinate system could not be projected to WGS84.',
  'geometryExport.kmz.noGeometryError': 'This model has no geometry to export.',
  'geometryExport.kmz.webNoticeTitle': 'Opens in Google Earth Pro (desktop)',
  'geometryExport.kmz.webNoticeDescription':
    "Google Earth on the web cannot show 3D models from a KMZ. For Earth on the web, use Export GLB and import it via the web app's Import 3D model option.",
  'geometryExport.kmz.modelLabel': 'Model',
  'geometryExport.kmz.selectModelPlaceholder': 'Select model',
  'geometryExport.kmz.outputLabel': 'Output',
  'geometryExport.kmz.outputFormat': 'Google Earth',
  'geometryExport.kmz.fileExtension': '.kmz',
  'geometryExport.kmz.placementLabel': 'Placement',
  'geometryExport.kmz.placementClampToGround': 'Rest on ground',
  'geometryExport.kmz.placementAbsolute': 'True elevation (MSL)',
  'geometryExport.kmz.placementClampHint': 'Drapes the model on the terrain so it never floats. Recommended.',
  'geometryExport.kmz.placementAbsoluteHint':
    "Places the model at its orthogonal height above sea level. Use only when the model's elevation is a true MSL value.",
  'geometryExport.kmz.suggestTrueElevationHint':
    'This model appears to carry absolute elevations in its geometry, so True elevation (MSL) will place it correctly here.',
  'geometryExport.kmz.successTitle': 'Success',
  'geometryExport.kmz.errorTitle': 'Error',
  'geometryExport.kmz.exportedMessage': 'Exported KMZ ({sizeKb} KB)',
  'geometryExport.kmz.exportFailedToast': 'KMZ export failed',
  'geometryExport.kmz.failedMessage': 'KMZ export failed: {reason}',
  'geometryExport.kmz.cancelButton': 'Cancel',
  'geometryExport.kmz.exportingButton': 'Exporting...',
  'geometryExport.kmz.exportButton': 'Export',

  // --- UsdExportDialog.tsx ---
  'geometryExport.usd.triggerButton': 'Export USD',
  'geometryExport.usd.dialogTitle': 'Export USD (OpenUSD)',
  'geometryExport.usd.dialogDescription':
    'A real Z-up OpenUSD ASCII ({usdaExt}) stage for usdview / Blender / Omniverse',
  'geometryExport.usd.modelLabel': 'Model',
  'geometryExport.usd.selectModelPlaceholder': 'Select model',
  'geometryExport.usd.outputLabel': 'Output',
  'geometryExport.usd.outputFormat': 'OpenUSD Stage',
  'geometryExport.usd.fileExtension': '.usda',
  'geometryExport.usd.blurb':
    'Emits a Z-up USD stage ({upAxis}, {metersPerUnit}) mirroring the IFC spatial hierarchy as {xform} prims, with {usdGeomMesh} geometry, {usdPreviewSurface} materials, and IFC metadata as custom attributes. Repeated mapped geometry is authored once as a referenced prototype; openings and spaces are tagged {purposeGuide}. Distinct from IFCX, which is USD-flavored JSON rather than a USD file.',
  'geometryExport.usd.noSourceTitle': 'No source available',
  'geometryExport.usd.noSourceDescription': 'USD export needs the original IFC file. Re-open the model from disk to enable it.',
  'geometryExport.usd.successTitle': 'Success',
  'geometryExport.usd.errorTitle': 'Error',
  'geometryExport.usd.exportedMessage': 'Exported USD ({sizeKb} KB)',
  'geometryExport.usd.failedMessage': 'USD export failed: {reason}',
  'geometryExport.usd.cancelButton': 'Cancel',
  'geometryExport.usd.exportingButton': 'Exporting...',
  'geometryExport.usd.exportButton': 'Export',

  // --- EnergyModelExportDialog.tsx ---
  'geometryExport.energy.triggerButton': 'Energy Model',
  'geometryExport.energy.dialogTitle': 'Export Energy Model',
  'geometryExport.energy.dialogDescription': 'Ladybug Tools model for energy and daylight analysis',
  'geometryExport.energy.hbjsonBlurb':
    'Full energy and daylight model. Builds watertight rooms from IfcSpace volumes, places windows and doors as apertures, emits railings as shades, and maps material layer sets to constructions.',
  'geometryExport.energy.dfjsonBlurb':
    'Extruded Room2D floor plates plus floor-to-ceiling heights, grouped into stories. The simpler target for models with mostly vertical walls (recommended by Ladybug Tools for that case).',
  'geometryExport.energy.formatLabel': 'Format',
  'geometryExport.energy.modelLabel': 'Model',
  'geometryExport.energy.selectModelPlaceholder': 'Select model',
  'geometryExport.energy.outputLabel': 'Output',
  'geometryExport.energy.outputModel': '{tool} model',
  'geometryExport.energy.noModelTitle': 'No model loaded',
  'geometryExport.energy.noModelDescription': 'Load an IFC model to export an energy model.',
  'geometryExport.energy.successTitle': 'Success',
  'geometryExport.energy.errorTitle': 'Error',
  'geometryExport.energy.modelDataUnavailableError': 'Model data is unavailable for export',
  'geometryExport.energy.noIfcSpaceError': 'No IfcSpace volumes found in the model to export',
  'geometryExport.energy.sourceBytesMissingError': '{formatLabel} export needs the source IFC bytes, which this model did not retain.',
  'geometryExport.energy.exportedMessage': 'Exported {formatLabel} ({sizeKb} KB){skipNote}',
  'geometryExport.energy.skipNote': ' — {skipped} of {total} IfcSpace skipped as degenerate',
  'geometryExport.energy.failedMessage': '{formatLabel} export failed: {reason}',
  'geometryExport.energy.cancelButton': 'Cancel',
  'geometryExport.energy.exportingButton': 'Exporting...',
  'geometryExport.energy.exportButton': 'Export {formatLabel}',

  // --- GeometryEditCard.tsx ---
  'geometryExport.editCard.header': 'Geometry',
  'geometryExport.editCard.positionSectionLabel': 'Storey-local position (IFC Z-up)',
  'geometryExport.editCard.nudgeStepAriaLabel': 'Nudge step in metres',
  'geometryExport.editCard.nudgeStepOption': '±{step} m',
  'geometryExport.editCard.nonStandardPlacementHint':
    "Entity has a non-standard placement (mapped representation or 2D-only). Move isn't supported directly — Duplicate and Delete still work.",
  'geometryExport.editCard.axisX': 'X',
  'geometryExport.editCard.axisY': 'Y',
  'geometryExport.editCard.axisZ': 'Z',
  'geometryExport.editCard.applyXyzButton': 'Apply XYZ',
  'geometryExport.editCard.enterNumericError': 'Enter numeric X, Y, Z coordinates',
  'geometryExport.editCard.moveFailedError': "Couldn't move: {reason}",
  'geometryExport.editCard.movedSuccess': 'Moved to ({coordinates})',
  'geometryExport.editCard.yawReadout': 'yaw {degrees}°',
  'geometryExport.editCard.yawReadoutEmpty': 'yaw —',
  'geometryExport.editCard.rotateMinus15AriaLabel': 'Rotate −15°',
  'geometryExport.editCard.rotateMinus15Tooltip': 'Rotate −15° (Shift+R)',
  'geometryExport.editCard.rotatePlus15AriaLabel': 'Rotate +15°',
  'geometryExport.editCard.rotatePlus15Tooltip': 'Rotate +15° (R)',
  'geometryExport.editCard.rotatePlus90AriaLabel': 'Rotate +90°',
  'geometryExport.editCard.rotatePlus90Tooltip': 'Rotate +90°',
  'geometryExport.editCard.rotateFailedError': "Couldn't rotate: {reason}",
  'geometryExport.editCard.splitButton': 'Split',
  'geometryExport.editCard.splitTooltip': 'Click on this wall to split it (K)',
  'geometryExport.editCard.duplicateButton': 'Duplicate',
  'geometryExport.editCard.duplicateTooltip': 'Clone the entity along its first axis',
  'geometryExport.editCard.duplicateFailedError': "Couldn't duplicate: {reason}",
  'geometryExport.editCard.duplicatedSuccess': 'Duplicated to #{expressId}',
  'geometryExport.editCard.deleteButton': 'Delete',
  'geometryExport.editCard.deleteTooltip': 'Tombstone the entity — undo to restore',
  'geometryExport.editCard.deleteFailedError': "Couldn't delete entity",
  'geometryExport.editCard.deletedSuccess': '{entityLabel} deleted — undo to restore',
} as const satisfies Record<string, TranslationValue>;
