/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A grab-bag catalogue (#4918 slice: standalone panels, part 1) covering
 * five unrelated one-off dialogs/panels bundled purely for PR-count
 * efficiency, each under its own key prefix:
 *
 * - `presentationPanel.*` — `presentation/PresentationPanel.tsx`, the
 *   `presentation` bottom panel's action row (counts, source/visibility/save/
 *   play-all controls) and the saved-view strip's rename/duration/delete
 *   actions. Formerly `BasketPresentationDock.tsx`'s own floating-card
 *   chrome (drag-to-move, resize, its own title/Hide row) before it became a
 *   bottom panel (#5508) and those moved to the strip's shared header
 *   (#5498) — the drag/resize/hide keys retired with them.
 * - `deviationPanel.*` — `DeviationPanel.tsx`, the BIM/scan deviation
 *   heatmap controls (compute button, stats line, range slider, and the
 *   diverging-ramp legend).
 * - `exportChangesReviewDialog.*` — `ExportChangesReviewDialog.tsx`, the
 *   pre-export change-review dialog (summary line, per-entity change
 *   descriptions' fixed value fallbacks, and footer controls).
 * - `scanSectionPanel.*` — `ScanSectionPanel.tsx`, the point-cloud scan
 *   overlay panel on the 2D section view (toggle, thickness/opacity
 *   sliders, and the status footnote).
 * - `spaceMousePanel.*` — `SpaceMousePanel.tsx`, the 3Dconnexion device
 *   settings (connect/disconnect, sensitivity, and diagnostics readout).
 *   Rendered inside the Preferences tab's Navigation section
 *   (`KeyboardShortcutsDialog.tsx`, #5509), not as a floating panel; its own
 *   section heading is catalogued there, not here.
 *
 * Several counted-fragment JSX expressions were combined into single
 * templated messages per the house rule against fragmenting a translated
 * message (`{count} in basket`, the deviation stats line, the SpaceMouse
 * report line, etc.) rather than left split across raw JSX text and a
 * bare unit suffix.
 *
 * `spaceMousePanel.deviceNameFallback` / `connectButton`
 * keep the literal English word `SpaceMouse` as their value: it is a
 * product/device name, not translated prose, per the house rule — routed
 * through `t()` only so the ending gate does not see it as an unconverted
 * JSX literal, the same reasoning the geometry-export and webgpu-
 * troubleshooting catalogues document for technical strings a translator
 * is expected to leave unchanged.
 */
export const miscPanelsAEn = {
  // PresentationPanel (`presentation` bottom panel, formerly BasketPresentationDock)
  'presentationPanel.inBasketCount': '{count} in collection',
  'presentationPanel.viewsCount': { one: '{count} view', other: '{count} views' },
  'presentationPanel.setFromContextTitle': 'Set collection from current context',
  'presentationPanel.addToBasketTitle': 'Add current context to collection',
  'presentationPanel.removeFromBasketTitle': 'Remove current context from collection',
  'presentationPanel.hideActiveBasketTitle': 'Hide active collection',
  'presentationPanel.showActiveBasketTitle': 'Show active collection',
  'presentationPanel.clearActiveBasketTitle': 'Clear active collection',
  'presentationPanel.saveCurrentViewTitle': 'Save current collection as presentation view',
  'presentationPanel.stopPlaybackTitle': 'Stop playback',
  'presentationPanel.playAllTitle': 'Play all saved views (Shift+Click to loop)',
  'presentationPanel.scrollLeftTitle': 'Scroll left',
  'presentationPanel.emptyStripHint':
    'Save collection views here. Click any card to restore both visibility and viewpoint.',
  'presentationPanel.activeBadge': 'Active',
  'presentationPanel.objectsCount': { one: '{count} object', other: '{count} objects' },
  'presentationPanel.transitionSuffix': ' · {duration}s',
  'presentationPanel.renameViewTitle': 'Rename view',
  'presentationPanel.setTransitionTitle': 'Set transition duration',
  'presentationPanel.transitionDurationPrompt': 'Transition duration in seconds (optional). Leave empty for the default smooth transition.',
  'presentationPanel.deleteViewTitle': 'Delete view',
  'presentationPanel.scrollRightTitle': 'Scroll right',

  // DeviationPanel
  'deviationPanel.sectionLabel': 'Deviation (BIM ↔ scan)',
  'deviationPanel.computeButtonTitle':
    'Build spatial index from {count} triangles, then signed-distance every loaded point against the nearest surface',
  'deviationPanel.computingLabel': 'Computing…',
  'deviationPanel.recomputeLabel': 'Recompute',
  'deviationPanel.computeLabel': 'Compute deviation',
  'deviationPanel.exportCsv': 'Export CSV',
  'deviationPanel.exportingCsv': 'Exporting CSV…',
  'deviationPanel.statsLine': '{points} pts vs. {triangles} tris in {duration} ms',
  'deviationPanel.rangeSliderTitle':
    'Deviation half-range in millimetres — values past ±this map to the ramp endpoints',
  'deviationPanel.rangeSliderAriaLabel': 'Deviation range half-width',
  'deviationPanel.rampAriaLabel': 'Deviation ramp from negative (blue) to positive (red)',
  'deviationPanel.sliderValueLabel': '±{value}mm',
  'deviationPanel.legendMinLabel': '−{value}mm (inside)',
  'deviationPanel.legendMaxLabel': '+{value}mm (outside)',
  'deviationPanel.switchToDeviationButton': 'Switch colour mode to Deviation',
  'deviationPanel.rendererNotReadyError': 'Renderer not initialised yet.',
  'deviationPanel.positionsChangedError': 'Model positions changed during computation. Compute deviation again.',
  'deviationPanel.noPointsError': 'No points processed — load a point cloud first.',
  'deviationPanel.noMeshError': 'No mesh geometry in the scene — load an IFC first.',

  // ExportChangesReviewDialog
  'exportChangesReviewDialog.title': 'Review changes',
  'exportChangesReviewDialog.kindAttribute': 'Attribute: {name}',
  'exportChangesReviewDialog.kindProperty': 'Property: {set}.{name}',
  'exportChangesReviewDialog.kindQuantity': 'Quantity: {set}.{name}',
  'exportChangesReviewDialog.kindPsetAdded': 'Property set added: {set}',
  'exportChangesReviewDialog.kindPsetDeleted': 'Property set deleted: {set}',
  'exportChangesReviewDialog.kindQsetAdded': 'Quantity set added: {set}',
  'exportChangesReviewDialog.kindQsetDeleted': 'Quantity set deleted: {set}',
  'exportChangesReviewDialog.kindType': 'Entity type',
  'exportChangesReviewDialog.kindEntityAdded': 'Entity created',
  'exportChangesReviewDialog.kindEntityDeleted': 'Entity deleted',
  'exportChangesReviewDialog.entityFallback': 'entity',
  'exportChangesReviewDialog.unknownTypeFallback': 'Unknown',
  'exportChangesReviewDialog.newEntityLabel': 'New {type} #{id}',
  'exportChangesReviewDialog.entityIdLabel': '#{id}',
  'exportChangesReviewDialog.entityTypeIdLabel': '{type} #{id}',
  'exportChangesReviewDialog.entityTypeIdNameLabel': '{type} #{id} — {name}',
  'exportChangesReviewDialog.noPendingChanges': 'No pending changes to export.',
  'exportChangesReviewDialog.modelsCount': { one: '{count} model', other: '{count} models' },
  'exportChangesReviewDialog.changesSummary': {
    one: '{count} change across {models} will be applied to the exported file{fileSuffix}.',
    other: '{count} changes across {models} will be applied to the exported file{fileSuffix}.',
  },
  'exportChangesReviewDialog.emptyStateMessage':
    'Nothing has changed since the last export — there is no overlay to apply.',
  'exportChangesReviewDialog.noneValue': '(none)',
  'exportChangesReviewDialog.deletedValue': '(deleted)',
  'exportChangesReviewDialog.unitemizedNote': {
    one: '+ {count} georeferencing / schedule change (not itemized above)',
    other: '+ {count} georeferencing / schedule changes (not itemized above)',
  },
  'exportChangesReviewDialog.cancelButton': 'Cancel',
  'exportChangesReviewDialog.exportingLabel': 'Exporting...',
  'exportChangesReviewDialog.exportButton': 'Export',

  // ScanSectionPanel
  'scanSectionPanel.showScanPointsLabel': 'Show scan points',
  'scanSectionPanel.noPointCloudMessage':
    'No point cloud is loaded. Load a .laz/.las/.e57/.ply/.pcd scan and this layer will show the points within a thin band around the section plane.',
  'scanSectionPanel.bandThicknessLabel': 'Band thickness: {value}',
  'scanSectionPanel.thicknessSliderTitle': 'Points within ± half this thickness of the section plane are shown',
  'scanSectionPanel.dotOpacityLabel': 'Dot opacity: {percent}%',
  'scanSectionPanel.includeInExportLabel': 'Include in SVG export',
  'scanSectionPanel.overlayHiddenMessage':
    'A scan is loaded but the overlay is hidden — enable "Show scan points" above.',
  'scanSectionPanel.showingAllMessage': 'Showing all {total} points in band.',
  'scanSectionPanel.showingPartialMessage': 'Showing {rendered} of {total} points in band (decimated for display).',

  // SpaceMousePanel — the Navigation section's own heading comes from
  // `settings.display.spaceMouseTitle` (Settings → Display, #5857), so no
  // header/drag-title strings live here any more.
  'spaceMousePanel.noWebHidMessage':
    'This browser has no WebHID support. Use a Chromium-based browser (Chrome or Edge) to navigate with a 3D mouse.',
  'spaceMousePanel.deviceNameFallback': 'SpaceMouse',
  'spaceMousePanel.disconnectTitle': 'Disconnect the device',
  'spaceMousePanel.disconnectButton': 'Disconnect',
  'spaceMousePanel.connectButton': 'Connect SpaceMouse',
  'spaceMousePanel.sensitivityLabel': 'Sensitivity',
  'spaceMousePanel.resetSensitivityTitle': 'Reset sensitivity',
  'spaceMousePanel.sensitivityValue': '{value}x',
  'spaceMousePanel.guidanceMessage':
    'Slide the cap to pan, push or pull it to zoom, twist and tilt to orbit. The device buttons fit the view. If the 3Dconnexion driver is running it may hold the device; quit it before connecting here.',
  'spaceMousePanel.diagnosticsLabel': 'Diagnostics',
  'spaceMousePanel.layoutLine': 'layout: {value}',
  'spaceMousePanel.layoutDescriptor': 'descriptor ({axes} axes)',
  'spaceMousePanel.layoutBuiltIn': 'built-in fallback',
  'spaceMousePanel.noReportsMessage': 'no reports received yet, move the cap',
  'spaceMousePanel.reportLine': 'report {id}: {count}x {bytes}B [{hex}]',
  'spaceMousePanel.copiedLabel': 'Copied',
  'spaceMousePanel.copyFailedLabel': 'Copy failed, try again',
  'spaceMousePanel.copyDeviceReportLabel': 'Copy device report',
  'spaceMousePanel.reportHintMessage':
    'If motion is wrong or dead for your device, copy this report and paste it into a GitHub issue so the axis layout can be fixed for your model.',
} as const;
