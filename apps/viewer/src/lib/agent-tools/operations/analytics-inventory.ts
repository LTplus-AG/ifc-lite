/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/** Actual controls examined in this family. Pending entries are implementation gaps,
 * not human-only claims and not panel-completion assertions. */
export const analyticsControlInventory = [
  { panel: 'lists', controls: [
    { control: 'Saved definitions/import/delete; columns, query Rules, model tags, grouping, sorting and aggregate configuration', operations: ['lists.library', 'lists.import', 'lists.replace', 'lists.delete', 'fields.schema', 'fields.properties', 'fields.values'] },
    { control: 'Execute a definition, completed rows, groups and aggregate summary with provenance', operations: ['lists.run'] },
    { control: 'CSV, Excel and PDF result writers', operations: ['lists.export'] },
    { control: 'Column pencil definition propagation preserving ID/order/custom labels; exact federated group Isolate/X-ray toggle and ownership-safe release', operations: ['lists.editColumn', 'lists.presentMembers', 'lists.releaseVisibility'] },
  ], pending: [], presentationOnly: ['Result-table expansion, widths, search and visibility-filter presentation; the current table has no inline IFC cell editing.'] },
  { panel: 'charts', controls: [
    { control: 'Dashboard import/delete/edit, chart type/source/filter/dimension/measure, scope/layout, focus mode and color in 3D', operations: ['charts.library', 'charts.import', 'charts.replace', 'charts.delete', 'charts.configure', 'fields.schema', 'fields.properties', 'fields.values'] },
    { control: 'Resolve source and Rules filter; aggregate, inspect exact marks, select/ghost/isolate/cross-filter and clear', operations: ['charts.evaluate', 'charts.focusBuckets', 'charts.clearFocus'] },
    { control: 'Native chart SVG writer', operations: ['charts.exportSvg', 'charts.exportReport'] },
  ], pending: ['Charts with non-IFC-only sources still require a model for evaluation in this slice.'] },
  { panel: 'gantt', controls: [
    { control: 'Source extraction versus actual pending Gantt snapshot/history, initialize target model', operations: ['schedule.tasks', 'schedule.containers', 'schedule.sequences', 'schedule.initialize', 'schedule.nativeData'] },
    { control: 'Task creation/identity/milestone/dates/deletion/product assignment, undo and redo', operations: ['schedule.moveTask', 'schedule.addTask', 'schedule.updateTask', 'schedule.updateTaskTime', 'schedule.deleteTask', 'schedule.assignProducts', 'schedule.history'] },
    { control: 'CSV/MSPDI import through native parser, preserving native clobber refusal', operations: ['schedule.import'] },
    { control: 'Generate dialog spatial/height strategy, start/duration/order/lag/linking/subgroups and optional work plan', operations: ['schedule.generatePreview', 'schedule.generate'] },
    { control: 'Timeline scale/work-schedule/seek/speed/loop/animation settings and pause', operations: ['schedule.timeline', 'schedule.configureTimeline', 'schedule.pause', 'schedule.play', 'schedule.workCalendarPlayback', 'schedule.animationSettings', 'schedule.configureAnimation'] },
    { control: 'Native modified-IFC schedule splice and schema-driven IFC/IFCX export', operations: ['exports.changedModels'] },
  ], pending: ['Replacing source-backed or edited schedules still requires native clobber-confirmation UI; the operation refuses it.'], nativeUnsupported: ['Gantt has no calendar authoring editor or CSV/MSPDI export UI. Existing IfcWorkCalendar attributes use generic IFC authoring; calendar badges/shading and playback are native read-only consumers.'] },
  { panel: 'cost', controls: [
    { control: 'Effective schedules/items/values, relationship tree, unresolved diagnostics and exact evaluation', operations: ['cost.schedules', 'cost.items', 'cost.values', 'cost.graph', 'cost.evaluate'] },
    { control: 'Select assigned targets and native CSV/JSON result artifacts', operations: ['cost.selectAssigned', 'cost.exportCsv', 'cost.exportGraph'] },
  ], pending: [], presentationOnly: ['Tree expansion and currently inspected detail item.'] },
  { panel: 'lens', controls: [
    { control: 'Saved Rules/auto-color configurations, import/update/delete and effective rule counts/colors/hidden IDs', operations: ['lens.state', 'lens.import', 'lens.delete'] },
    { control: 'Await native evaluation and apply/clear owned color/hide/isolation output without mounted panel', operations: ['lens.apply', 'lens.clear', 'lens.ruleMembers', 'lens.discover'] },
  ], pending: [], presentationOnly: ['Rule/card expansion, local draft editing before save. Native import/upsert is the persisted configuration workflow.'] },
  { panel: 'appearance', controls: [
    { control: 'Registered source/draft/committed recipe inspection and source removal', operations: ['appearance.state', 'appearance.removeSource'] },
    { control: 'Existing-UV/planar/box settings on explicit products; native Rust preview, revision-bound apply and discard', operations: ['appearance.preview', 'appearance.applyPreview', 'appearance.cancelPreview', 'appearance.configureDraft'] },
  ], pending: ['Local image/PDF registration/upload, PDF page/calibration editor, reference/capture/scan intents and face-mask editing have no operation contracts.', 'Preview uses complete explicit products; supported-only narrowing of partial exclusions requires a new candidate.', 'The native Compare toggle has no direct candidate-preserving binding; original display is obtainable by cancelling and rebuilding a preview.'] },
  { panel: 'environment', controls: [
    { control: 'Preset/exposure/hardness/softness/sky/shadows/angular diameter/resolution/solar time', operations: ['environment.read', 'environment.exposure', 'environment.hardness', 'environment.softness', 'environment.sky', 'environment.shadows', 'environment.sunAngle', 'environment.sunTime', 'environment.sunTimeEnabled', 'environment.configurePreset'] },
  ], pending: [], nativeUnsupported: ['Current lighting UI has no separate solar-study analysis job; native lighting settings are exposed.'] },
  { panel: 'drawing', controls: [
    { control: 'Generation completion/progress/errors, current plane, overrides and markups', operations: ['drawing.state'] },
    { control: 'Native viewer-scoped cut request queue and terminal result; display/IFC/symbolic annotation settings', operations: ['drawing.generate', 'drawing.configureDisplay'] },
    { control: 'Sheet configuration/templates and numerical markup authoring/edit/move/delete/native dimension history', operations: ['drawing.sheets', 'drawing.createSheet', 'drawing.replaceSheet', 'drawing.clearSheet', 'drawing.saveSheetTemplate', 'drawing.sheetTemplate', 'drawing.markups', 'drawing.addPolygon', 'drawing.addCloud', 'drawing.addText', 'drawing.editText', 'drawing.addDimension', 'drawing.addTag', 'drawing.moveMarkup', 'drawing.deleteMarkup', 'drawing.dimensionHistory', 'drawing.overrideLibrary', 'drawing.configureOverrides', 'drawing.upsertOverrideRule', 'drawing.deleteOverrideRule', 'drawing.configureProjection', 'drawing.configureDxfUnderlay', 'drawing.deleteDxfUnderlay', 'drawing.centerDxf', 'drawing.importDxf', 'drawing.styleText'] },
    { control: 'Numerical 2D distances and generated SVG cache artifact', operations: ['drawing.measure', 'drawing.exportGeneratedSvg', 'drawing.export'] },
  ], pending: ['Native cut admission cannot cancel GPU work after dispatch; its completion is awaited.'], nativeUnsupported: ['DXF reference-frame registration is the native import-time option exposed by drawing.importDxf; no current per-underlay frame editor exists. Browser Print is a native user gesture; file exports are exposed.'] },
  { panel: 'measurements', controls: [
    { control: 'Numerical distance/perimeter/three-point-angle/circular-edge-radius completion, deletion/clear/reference', operations: ['measurements.read', 'measurements.distance', 'measurements.polyline', 'measurements.angle', 'measurements.radius', 'measurements.deleteDistance', 'measurements.delete', 'measurements.clear', 'measurements.reference', 'measurements.clearReference', 'measurements.settings', 'measurements.configure', 'measurements.placePoint', 'measurements.angleEdges', 'measurements.angleFaces', 'measurements.readouts'] },
  ], pending: ['Pointer-hover snap target/edge-lock/Shift-axis visualizations are presentation gestures; explicit numerical points, readouts and native snap/mode/geo settings are exposed.'] },
  { panel: 'presentation', controls: [
    { control: 'Saved basket/camera/section snapshots and names/timing, save with/without native thumbnail, apply and delete', operations: ['presentation.views', 'presentation.save', 'presentation.capture', 'presentation.apply', 'presentation.configureView', 'presentation.delete', 'presentation.play', 'presentation.playback', 'presentation.stop'] },
  ], pending: ['Applying a saved view dispatches a camera transition; the operation does not report that transition as finished.', 'Basket controls use the shared basket.read/replace/add/remove/hierarchySource/clear/show operations owned by hierarchy.'] },
  { panel: 'document', controls: [
    { control: 'Initialize/read native IndexedDB library; import, expected-snapshot edit of all structured blocks/page settings and delete', operations: ['document.initialize', 'document.library', 'document.import', 'document.replace', 'document.delete'] },
    { control: 'Real JSON/PDF artifacts, awaiting all tables/charts/rendering with page count and explicit warnings', operations: ['document.export'] },
  ], pending: ['Image-file ingestion, AI-generated reports, source picker/catalog discovery and advanced block insertion helpers are not separate operations; structured validated block configuration is exposed.', 'Document replacement uses a whole-document expected snapshot rather than individual block patches.'] },
  { panel: 'pointclouds', controls: [
    { control: 'Color modes/fixed RGBA, sizes/shape, EDL, all 256 class visibility bits, decimation, CRS alignment and deviation-ramp settings', operations: ['pointclouds.read', 'pointclouds.colorMode', 'pointclouds.fixedColor', 'pointclouds.pointSize', 'pointclouds.worldRadius', 'pointclouds.edl', 'pointclouds.classMask', 'pointclouds.configureDisplay'] },
    { control: 'Shared native GPU deviation/readback, complete pooled/per-asset/tolerance statistics, provenance and safe CSV artifact', operations: ['pointclouds.computeDeviation', 'pointclouds.deviationStatistics', 'pointclouds.exportDeviation'] },
  ], pending: ['Native source loading/per-model transforms are tracked by the source/model family, not claimed by the display adapter.', 'GPU dispatch is explicitly non-cancellable after admission; statistics completion is awaited.', 'GPU-success evidence requires a real renderer/scan fixture; this checkout test run only covers native panel fixtures and refusal boundaries.'] },
] as const;

/** Individual remaining native controls for the next coverage decision. No row
 * below is labelled human-only merely because its service extraction is pending. */
export const analyticsRemainingNativeControls = [
  { panel: 'gantt', control: 'Replace source-backed/edited schedule from an imported file', classification: 'native-confirmation-boundary', native: 'useScheduleFileImport.shouldConfirmClobber; operation refuses replacement' },
  { panel: 'appearance', control: 'Image/PDF file picker and encrypted PDF password prompt', classification: 'native-input-boundary', native: 'useAppearancePanel.upload and usePdfAppearanceSource' },
  { panel: 'appearance', control: 'PDF page/raster recipe and two-landmark scale calibration', classification: 'missing-native-binding', native: 'pdf-controls.ts; AppearanceCalibrationFields' },
  { panel: 'appearance', control: 'Face-mask authoring and candidate-preserving Compare', classification: 'missing-native-binding', native: 'face-mask/useFaceMasks; useAppearancePanel.compare' },
  { panel: 'appearance', control: 'Reference/capture/scan intent workflows', classification: 'missing-native-binding', native: 'AppearanceCapturePanel; AppearanceScanPanel; reference controller' },
  { panel: 'drawing', control: 'Browser Print dialog', classification: 'native-user-gesture-boundary', native: 'useDrawingExport.handlePrint; file artifacts are exposed independently' },
  { panel: 'document', control: 'Image insertion file picker and AI report generation', classification: 'native-input-or-provider-boundary', native: 'DocumentPanel image inputs and AI report provider workflows; structured native blocks/import/PDF are exposed' },
  { panel: 'measurements', control: 'Pointer hover target/edge-lock/Shift-axis visualization', classification: 'presentation-gesture', native: 'measurementSlice snap/constraint/edgeLock state; explicit numerical geometry and native settings are exposed' },
] as const;
