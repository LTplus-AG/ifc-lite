/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/** Actual controls examined in this family. Pending entries are implementation gaps,
 * not human-only claims and not panel-completion assertions. */
export const analyticsControlInventory = [
  { panel: 'lists', controls: [
    { control: 'Saved definitions/import/delete; columns, query Rules, model tags, grouping, sorting and aggregate configuration', operations: ['lists.library', 'lists.import', 'lists.replace', 'lists.delete'] },
    { control: 'Execute a definition, completed rows, groups and aggregate summary with provenance', operations: ['lists.run'] },
    { control: 'CSV, Excel and PDF result writers', operations: ['lists.export'] },
  ], pending: ['Column metadata discovery UI is still hook-driven.', 'List group isolate/X-ray context actions and inline cell edits are not bound to operation IDs.', 'Result-table presentation preferences (group expansion, widths and displayed sort) are not separately exposed.'] },
  { panel: 'charts', controls: [
    { control: 'Dashboard import/delete/edit, chart type/source/filter/dimension/measure, scope/layout, focus mode and color in 3D', operations: ['charts.library', 'charts.import', 'charts.replace', 'charts.delete', 'charts.configure'] },
    { control: 'Resolve source and Rules filter; aggregate, inspect exact marks, select/ghost/isolate/cross-filter and clear', operations: ['charts.evaluate', 'charts.focusBuckets', 'charts.clearFocus'] },
    { control: 'Native chart SVG writer', operations: ['charts.exportSvg'] },
  ], pending: ['ReportExportDialog multi-chart report paper/layout/PDF controls have no dedicated operation.', 'Per-chart selector/IFC field discovery remains mounted-editor driven.', 'Charts with non-IFC-only sources still require a model for evaluation in this slice.'] },
  { panel: 'gantt', controls: [
    { control: 'Source extraction versus actual pending Gantt snapshot/history, initialize target model', operations: ['schedule.tasks', 'schedule.containers', 'schedule.sequences', 'schedule.initialize', 'schedule.nativeData'] },
    { control: 'Task creation/identity/milestone/dates/deletion/product assignment, undo and redo', operations: ['schedule.addTask', 'schedule.updateTask', 'schedule.updateTaskTime', 'schedule.deleteTask', 'schedule.assignProducts', 'schedule.history'] },
    { control: 'CSV/MSPDI import through native parser, preserving native clobber refusal', operations: ['schedule.import'] },
    { control: 'Generate dialog spatial/height strategy, start/duration/order/lag/linking/subgroups and optional work plan', operations: ['schedule.generatePreview', 'schedule.generate'] },
    { control: 'Timeline scale/work-schedule/seek/speed/loop/animation settings and pause', operations: ['schedule.timeline', 'schedule.configureTimeline', 'schedule.pause', 'schedule.play', 'schedule.workCalendarPlayback'] },
  ], pending: ['Replacing source-backed or edited schedules still requires native clobber-confirmation UI; the operation refuses it.', 'Task reorder, calendar authoring, advanced animation style/palette settings and schedule-specific export controls are not parameterized.'] },
  { panel: 'cost', controls: [
    { control: 'Effective schedules/items/values, relationship tree, unresolved diagnostics and exact evaluation', operations: ['cost.schedules', 'cost.items', 'cost.values', 'cost.graph', 'cost.evaluate'] },
    { control: 'Select assigned targets and native CSV/JSON result artifacts', operations: ['cost.selectAssigned', 'cost.exportCsv', 'cost.exportGraph'] },
  ], pending: [], presentationOnly: ['Tree expansion and currently inspected detail item.'] },
  { panel: 'lens', controls: [
    { control: 'Saved Rules/auto-color configurations, import/update/delete and effective rule counts/colors/hidden IDs', operations: ['lens.state', 'lens.import', 'lens.delete'] },
    { control: 'Await native evaluation and apply/clear owned color/hide/isolation output without mounted panel', operations: ['lens.apply', 'lens.clear'] },
  ], pending: ['Lazy data-value discovery and per-rule isolate/select context actions are not operation-bound.', 'Definition import uses the native merge path; a separate expected-value patch contract is still needed for collaborative configuration edits.'] },
  { panel: 'appearance', controls: [
    { control: 'Registered source/draft/committed recipe inspection and source removal', operations: ['appearance.state', 'appearance.removeSource'] },
    { control: 'Existing-UV/planar/box settings on explicit products; native Rust preview, revision-bound apply and discard', operations: ['appearance.preview', 'appearance.applyPreview', 'appearance.cancelPreview'] },
  ], pending: ['Local image/PDF registration/upload, PDF page/calibration editor, reference/capture/scan intents and face-mask editing have no operation contracts.', 'Preview uses complete explicit products; supported-only narrowing of partial exclusions requires a new candidate.', 'Original-versus-preview comparison and draft persistence/UI synchronization are not separately exposed.'] },
  { panel: 'environment', controls: [
    { control: 'Preset/exposure/hardness/softness/sky/shadows/angular diameter/resolution/solar time', operations: ['environment.read', 'environment.exposure', 'environment.hardness', 'environment.softness', 'environment.sky', 'environment.shadows', 'environment.sunAngle', 'environment.sunTime', 'environment.sunTimeEnabled', 'environment.configurePreset'] },
  ], pending: [], nativeUnsupported: ['Current lighting UI has no separate solar-study analysis job; native lighting settings are exposed.'] },
  { panel: 'drawing', controls: [
    { control: 'Generation completion/progress/errors, current plane, overrides and markups', operations: ['drawing.state'] },
    { control: 'Native viewer-scoped cut request queue and terminal result; display/IFC/symbolic annotation settings', operations: ['drawing.generate', 'drawing.configureDisplay'] },
    { control: 'Sheet configuration/templates and numerical markup authoring/edit/move/delete/native dimension history', operations: ['drawing.sheets', 'drawing.createSheet', 'drawing.replaceSheet', 'drawing.clearSheet', 'drawing.saveSheetTemplate', 'drawing.sheetTemplate', 'drawing.markups', 'drawing.addPolygon', 'drawing.addCloud', 'drawing.addText', 'drawing.editText', 'drawing.addDimension', 'drawing.addTag', 'drawing.moveMarkup', 'drawing.deleteMarkup', 'drawing.dimensionHistory'] },
    { control: 'Numerical 2D distances and generated SVG cache artifact', operations: ['drawing.measure', 'drawing.exportGeneratedSvg'] },
  ], pending: ['Full composed SVG/DXF/PDF sheet exports (references, dimensions, overlays and title blocks) remain hook-bound; cached SVG export does not claim those layers.', 'Graphic-override authoring, DXF/raster underlay management, selected text typography updates and snap/constraint settings are not bound.', 'Native cut admission cannot cancel GPU work after dispatch; its completion is awaited.'] },
  { panel: 'measurements', controls: [
    { control: 'Numerical distance/perimeter/three-point-angle/circular-edge-radius completion, deletion/clear/reference', operations: ['measurements.read', 'measurements.distance', 'measurements.polyline', 'measurements.angle', 'measurements.radius', 'measurements.deleteDistance', 'measurements.delete', 'measurements.clear', 'measurements.reference', 'measurements.clearReference'] },
  ], pending: ['Edge-pair and face-normal angles, inclination/setting-out readout options, snap targets/constraints, geographic readouts and gesture-mode settings have no operation contracts.'] },
  { panel: 'presentation', controls: [
    { control: 'Saved basket/camera/section snapshots and names/timing, save with/without native thumbnail, apply and delete', operations: ['presentation.views', 'presentation.save', 'presentation.capture', 'presentation.apply', 'presentation.configureView', 'presentation.delete', 'presentation.play', 'presentation.playback', 'presentation.stop'] },
  ], pending: ['Applying a saved view dispatches a camera transition; the operation does not report that transition as finished.', 'Basket set/add/remove source controls use separate native basket/selection operations and are not bound here.'] },
  { panel: 'document', controls: [
    { control: 'Initialize/read native IndexedDB library; import, expected-snapshot edit of all structured blocks/page settings and delete', operations: ['document.initialize', 'document.library', 'document.import', 'document.replace', 'document.delete'] },
    { control: 'Real JSON/PDF artifacts, awaiting all tables/charts/rendering with page count and explicit warnings', operations: ['document.export'] },
  ], pending: ['Image-file ingestion, AI-generated reports, source picker/catalog discovery and advanced block insertion helpers are not separate operations; structured validated block configuration is exposed.', 'Document replacement uses a whole-document expected snapshot rather than individual block patches.'] },
  { panel: 'pointclouds', controls: [
    { control: 'Color modes/fixed RGBA, sizes/shape, EDL, all 256 class visibility bits, decimation, CRS alignment and deviation-ramp settings', operations: ['pointclouds.read', 'pointclouds.colorMode', 'pointclouds.fixedColor', 'pointclouds.pointSize', 'pointclouds.worldRadius', 'pointclouds.edl', 'pointclouds.classMask', 'pointclouds.configureDisplay'] },
    { control: 'Shared native GPU deviation/readback, complete pooled/per-asset/tolerance statistics, provenance and safe CSV artifact', operations: ['pointclouds.computeDeviation', 'pointclouds.deviationStatistics', 'pointclouds.exportDeviation'] },
  ], pending: ['Native source loading/per-model transforms are tracked by the source/model family, not claimed by the display adapter.', 'GPU dispatch is explicitly non-cancellable after admission; statistics completion is awaited.', 'GPU-success evidence requires a real renderer/scan fixture; this checkout test run only covers native panel fixtures and refusal boundaries.'] },
] as const;
