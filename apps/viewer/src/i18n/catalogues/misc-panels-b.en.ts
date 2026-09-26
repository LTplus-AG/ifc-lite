/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * The #4918 sweep's final "grab-bag" slice: eighteen small, otherwise
 * unrelated standalone components grouped into one file purely to avoid
 * eighteen near-empty catalogue files, one key prefix per component:
 * `pointCloudPanel.*` / `pointCloudClasses.*` / `pointCloudLegend.*`
 * (`PointCloudPanel.tsx`, `PointCloudClasses.tsx`, `PointCloudLegend.tsx`
 * — the point-cloud rendering controls, per-ASPRS-class visibility list,
 * and intensity/height ramp legends), `modelTagRuleEditor.*`
 * (`ModelTagRuleEditor.tsx`, the shared `modelTag` chip rule editor),
 * `federationSetupControls.*` (`FederationSetupControls.tsx`, the
 * save/reopen federation-setup dialog, including its slot-match
 * confidence badges), `shareDialog.*` / `shareScopeField.*`
 * (`ShareDialog.tsx`, `ShareScopeField.tsx`, the accountless link-sharing
 * dialog and its multi-model scope picker), `loadReportPanel.*`
 * (`LoadReportPanel.tsx`, the per-model geometry load-warning report),
 * `geometryModeBanner.*` (`GeometryModeBanner.tsx`, the reload-to-apply
 * Fast/Exact geometry banner), `filterRuleControls.*`
 * (`FilterRuleControls.tsx`, the shared AND/OR combinator toggle and
 * "Add rule" menu), `geometryAxisRow.*` (`GeometryAxisRow.tsx`, the
 * Geometry edit card's X/Y/Z nudge row),
 * `entityContextMenu.*` (`EntityContextMenu.tsx` — its default-direction
 * duplicate row plus the frame/hide/basket/show-all items that carry a
 * shortcut hint (#5597); the menu's remaining per-action `label` props are
 * still plain JSX attributes, out of THIS slice's scope), `textAnnotationEditor.*`
 * (`TextAnnotationEditor.tsx`, the 2D-drawing text annotation inline
 * editor), `peerPresenceLayer.*` (`presence/PeerPresenceLayer.tsx`, the
 * live-cursor DOM overlay), `bottomStrip.*` (`BottomStrip.tsx` /
 * `BottomStripHeader.tsx`'s tab row, detach grip, maximize/restore and
 * Close, #5498), `saveMarkupToModelButton.*` / `exportChangesButton.*`
 * (`SaveMarkupToModelButton.tsx`, `ExportChangesButton.tsx` — the two
 * dedicated export-adjacent toolbar buttons), and `searchableSelect.*`
 * (`SearchableSelect.tsx`, the searchable dropdown `LensPanel`'s editors
 * use).
 *
 * Several small data tables solely defined and consumed inside one of
 * these files moved to the same `labelKey`/`hintKey`-per-row pattern
 * `sectionConstants.ts`'s `AXIS_INFO` established: `PointCloudPanel.tsx`'s
 * `COLOR_MODES`/`SIZE_MODES`, `ShareDialog.tsx`'s `ROLE_OPTIONS`, and
 * `FederationSetupControls.tsx`'s `confidenceBadge()` match-confidence
 * table — none of these are hardcoded JSX text the gate below flags (the
 * row value only ever reaches JSX through a variable), but leaving them
 * untranslated while every other user-facing string in the same small
 * file goes through `t()` would read as an arbitrary gap. Toast/console
 * messages that never reach the DOM (`SaveMarkupToModelButton.tsx`'s
 * `refusalText()`, `ExportChangesButton.tsx`'s `toast.*` calls,
 * `FederationSetupControls.tsx`'s `toast.*` calls) are deliberately left
 * English, same reasoning several earlier slices already document (e.g.
 * the charts catalogue's `DashboardMenu.tsx`/`ReportExportDialog.tsx`
 * exclusions) — they are not on-screen chrome this slice's "no hardcoded
 * JSX text" charter is about.
 *
 * Point-cloud ASPRS CLASS names (`lasClassificationName()`) are model
 * content loaded from the scan and stay out of the catalogue, same house
 * rule as an IFC class/property/tag NAME anywhere else in this sweep.
 */
export const miscPanelsBEn = {
  // ---- PointCloudPanel.tsx --------------------------------------------
  'pointCloudPanel.title': 'Point Cloud',
  'pointCloudPanel.close': 'Close point cloud panel',
  'pointCloudPanel.assetCount': { one: '{count} asset', other: '{count} assets' },
  'pointCloudPanel.colourSectionLabel': 'Colour',
  'pointCloudPanel.colorMode.rgb.label': 'RGB',
  'pointCloudPanel.colorMode.rgb.hint': 'Per-point colour from the source',
  'pointCloudPanel.colorMode.classification.label': 'Classification',
  'pointCloudPanel.colorMode.classification.hint':
    'ASPRS class palette (ground, vegetation, building...)',
  'pointCloudPanel.colorMode.intensity.label': 'Intensity',
  'pointCloudPanel.colorMode.intensity.hint': 'Greyscale ramp from per-point intensity',
  'pointCloudPanel.colorMode.height.label': 'Height',
  'pointCloudPanel.colorMode.height.hint': 'Cool-warm ramp by Y-up world height',
  'pointCloudPanel.colorMode.fixed.label': 'Solid',
  'pointCloudPanel.colorMode.fixed.hint': 'Single colour override',
  'pointCloudPanel.colorMode.deviation.label': 'Deviation',
  'pointCloudPanel.colorMode.deviation.hint':
    'Signed distance to nearest BIM surface (compute below)',
  'pointCloudPanel.deviation.computeHint':
    'Run “Compute deviation” below to populate the heatmap.',
  'pointCloudPanel.deviation.needsModelHint': 'Load a BIM model to compare the scan against.',
  'pointCloudPanel.solidColourLabel': 'Solid colour',
  'pointCloudPanel.solidColourPickerAriaLabel': 'Pick the solid colour applied in fixed mode',
  'pointCloudPanel.alignToModel.hint':
    "Applies the inverse IfcMapConversion so the scan's absolute map coordinates (eastings/northings/height) line up with the IFC model. Turn off to see the scan at its raw, un-transformed coordinates.",
  'pointCloudPanel.alignToModel.label': 'Align to model georeference',
  'pointCloudPanel.alignToModel.checkboxTitle': 'Align to model georeference (IfcMapConversion)',
  'pointCloudPanel.sizeSectionLabel': 'Size',
  'pointCloudPanel.sizeMode.fixedPx.label': 'Fixed',
  'pointCloudPanel.sizeMode.fixedPx.hint': 'Always render at the slider value (in pixels)',
  'pointCloudPanel.sizeMode.attenuated.label': 'Auto',
  'pointCloudPanel.sizeMode.attenuated.hint':
    'Adaptive (closer = bigger), clamped to the slider as max',
  'pointCloudPanel.sizeMode.adaptiveWorld.label': 'World',
  'pointCloudPanel.sizeMode.adaptiveWorld.hint':
    'Pure world-space radius — splat covers N mm in source space',
  'pointCloudPanel.pointSizePx': '{value}px',
  'pointCloudPanel.splatSizeTitle': 'Splat size in pixels (or upper cap in Auto mode)',
  'pointCloudPanel.worldRadiusMm': '{value}mm',
  'pointCloudPanel.worldRadiusTitle': 'World-space splat radius in millimetres',
  'pointCloudPanel.edlSectionLabel': 'Edge shading',
  'pointCloudPanel.edlCheckboxTitle':
    'Edge shading (EDL, Eye-Dome Lighting) adds depth perception to point clouds.',
  'pointCloudPanel.edlStrengthTitle': 'Edge shading (EDL) strength',

  // ---- PointCloudClasses.tsx -------------------------------------------
  'pointCloudClasses.summaryLabel': 'Classes',
  'pointCloudClasses.visibleCount': '{visible} of {total} visible',
  'pointCloudClasses.emptyState': 'No classification data in the loaded scans.',
  'pointCloudClasses.showAll': 'Show all',
  'pointCloudClasses.toggleAriaLabel': 'Toggle {label} (class {classId})',

  // ---- PointCloudLegend.tsx --------------------------------------------
  'pointCloudLegend.intensityLabel': 'Intensity',
  'pointCloudLegend.intensityRampAriaLabel':
    'Intensity ramp from low (black) to high (white)',
  'pointCloudLegend.low': 'low',
  'pointCloudLegend.high': 'high',
  'pointCloudLegend.heightLabel': 'Height (Y-up)',
  'pointCloudLegend.heightRampAriaLabel': 'Height ramp from low (blue) to high (red)',

  // ---- ModelTagRuleEditor.tsx -------------------------------------------
  'modelTagRuleEditor.pickTagsAriaLabel': 'Pick model tags',
  'modelTagRuleEditor.pickTagsPlaceholder': 'Pick tags…',
  'modelTagRuleEditor.selectedCount': '{count} selected',
  'modelTagRuleEditor.noTagsYet': 'No model tags yet — tag a model in the hierarchy first.',
  'modelTagRuleEditor.unresolvedWarning': {
    one: 'A tag in this rule no longer exists — the rule matches nothing until it is fixed.',
    other: '{count} tags in this rule no longer exist — the rule matches nothing until it is fixed.',
  },

  // ---- FederationSetupControls.tsx --------------------------------------
  'federationSetupControls.reopenTitle': 'Reopen federation setup',
  'federationSetupControls.reopenDescription':
    'Review how each saved model slot matched your local files before restoring.',
  'federationSetupControls.cancel': 'Cancel',
  'federationSetupControls.restoringButton': 'Restoring…',
  'federationSetupControls.restoreButton': 'Restore federation',
  'federationSetupControls.confidence.content': 'Matched',
  'federationSetupControls.confidence.nameSize': 'Matched (by name)',
  'federationSetupControls.confidence.nameOnly': 'Same name, different file',
  'federationSetupControls.confidence.none': 'Missing',

  // ---- ShareDialog.tsx ---------------------------------------------------
  'shareDialog.titleMulti': 'Share {count} models',
  'shareDialog.titleSingle': 'Share “{model}”',
  'shareDialog.description': 'Anyone with the link can join — no account needed.',
  'shareDialog.loadModelFirst': 'Load a model first, then share it.',
  'shareDialog.anyoneCanLabel': 'Anyone with the link can',
  'shareDialog.accessLevelAriaLabel': 'Access level',
  'shareDialog.role.viewer.label': 'View',
  'shareDialog.role.viewer.hint': 'See the model, cursors, and comments',
  'shareDialog.role.commenter.label': 'Comment',
  'shareDialog.role.commenter.hint': 'Also add issues and markups',
  'shareDialog.role.editor.label': 'Edit',
  'shareDialog.role.editor.hint': 'Also change properties and geometry',
  'shareDialog.linkLabel': 'Link',
  'shareDialog.copied': 'Copied',
  'shareDialog.copy': 'Copy',
  'shareDialog.copyFailed': 'Could not copy the link. Select it in the field and copy it manually.',
  'shareDialog.liveNow': 'Live now',
  'shareDialog.linkExpiryNotice': 'Link expires in 7 days. Anyone with it gets {role} access.',
  'shareDialog.youSuffix': '{name} (you)',
  'shareDialog.guestName': 'Guest',
  'shareDialog.roomCreationFailed':
    'No session was created. Close and reopen this dialog to try again.',
  'shareDialog.linkCreationFailed': 'Link creation failed. Check the connection and try again.',
  'shareDialog.joinedViaInvite':
    'You joined via an invite - sharing it forwards the same access. Only the session admin can mint new links.',
  'shareDialog.onlyAdminCanCreate': 'Only the session admin can create invite links for this session.',
  'shareDialog.mintFailedReusing':
    'Could not mint a fresh link - reusing your current invite (same access).',
  'shareDialog.linkField.awaitingScope': 'Choose what to share, then create the link',
  'shareDialog.linkField.awaitingConsent': 'Create the link to share this model',
  'shareDialog.linkField.seedInFlight': 'Link is ready once the upload finishes…',
  'shareDialog.linkField.creatingRoom': 'Creating session…',
  'shareDialog.linkField.generating': 'Generating link…',

  // ---- ShareScopeField.tsx -----------------------------------------------
  'shareScopeField.allPartial': 'All {seedable} of {loaded} loaded models',
  'shareScopeField.allFull': 'All {loaded} loaded models',
  'shareScopeField.roomCarries': {
    one: 'This session carries {count} model.',
    other: 'This session carries {count} models.',
  },
  'shareScopeField.partialCanBeShared':
    '{seedable} of {loaded} loaded models can be shared, each as its own model; a GLB, a point cloud or a model still loading has nothing to put in a session.',
  'shareScopeField.allShared':
    'Every loaded model is shared as its own model, so recipients see the whole workspace.',
  'shareScopeField.onlyActiveShared':
    'Only “{model}” is shared; the other loaded models stay private.',
  'shareScopeField.shareLabel': 'Share',
  'shareScopeField.scopeAriaLabel': 'Share scope',
  'shareScopeField.activeOnly': 'Active model only',
  'shareScopeField.createLink': 'Create link',
  'shareScopeField.uploadNotice':
    'Creating the link uploads the shared model data to the collaboration server, so people with the link can open it.',

  // ---- LoadReportPanel.tsx ------------------------------------------------
  'loadReportPanel.selectAndFrameTitle': 'Select and frame this entity',
  'loadReportPanel.entitySummary':
    '#{productId} {ifcType} — {csgFailures} failure(s), {openings} opening(s)',
  'loadReportPanel.tierSuffix': ' · tier {tier}',
  'loadReportPanel.fastModeSuffix': ' · fast mode',
  'loadReportPanel.affectedEntitiesLabel': 'Affected entities',
  'loadReportPanel.title': 'Load report',
  'loadReportPanel.exportJsonTitle': 'Export JSON',
  'loadReportPanel.closeTitle': 'Close',
  'loadReportPanel.noModelsLoaded': 'No models loaded.',
  'loadReportPanel.status.unavailable': 'Diagnostics unavailable',
  'loadReportPanel.status.clean': 'Clean',
  'loadReportPanel.status.issuesFound': 'Issues found',

  // ---- GeometryModeBanner.tsx ---------------------------------------------
  'geometryModeBanner.detailPinRemoved': 'Detail pin removed',
  'geometryModeBanner.fastEnabled': 'Fast geometry enabled',
  'geometryModeBanner.exactEnabled': 'Exact geometry enabled',
  'geometryModeBanner.reloadHint': 'Reload model to apply the new setting.',
  'geometryModeBanner.reloadButton': 'Reload',
  'geometryModeBanner.dismissAriaLabel': 'Dismiss reload reminder',

  // ---- FilterRuleControls.tsx ---------------------------------------------
  'filterRuleControls.combinatorTitle': 'AND requires every rule to match. OR matches any rule.',
  'filterRuleControls.filterDimensionLabel': 'Filter dimension',
  'filterRuleControls.addRuleDefaultLabel': 'Add rule',

  // ---- GeometryAxisRow.tsx -------------------------------------------------
  'geometryAxisRow.decreaseAriaLabel': 'Decrease {label}',
  'geometryAxisRow.increaseAriaLabel': 'Increase {label}',

  // ---- EntityContextMenu.tsx (shortcut-hinted items + DuplicateRow, see doc comment)
  'entityContextMenu.duplicateDefaultTitle': 'Duplicate one bbox-width along +X (default)',
  'entityContextMenu.duplicateLabel': 'Duplicate',
  'entityContextMenu.frameSelection': 'Frame selection',
  'entityContextMenu.hide': 'Hide',
  'entityContextMenu.setBasket': 'Set Collection',
  'entityContextMenu.addToBasket': 'Add to Collection',
  'entityContextMenu.removeFromBasket': 'Remove from Collection',
  'entityContextMenu.saveBasketView': 'Save Collection View',
  'entityContextMenu.showAll': 'Show all',

  // ---- TextAnnotationEditor.tsx ---------------------------------------------
  'textAnnotationEditor.placeholder': 'Type annotation text...',
  'textAnnotationEditor.hint': 'Enter to confirm · Shift+Enter for newline · Esc to cancel',

  // ---- presence/PeerPresenceLayer.tsx -----------------------------------------
  'peerPresenceLayer.cursorsAriaLabel': 'Collaborator cursors',
  'peerPresenceLayer.guestName': 'Guest',
  'peerPresenceLayer.nameWithTool': '{name} — {tool}',

  // ---- BottomStrip.tsx / BottomStripHeader.tsx --------------------------------
  'bottomStrip.gripTitle': 'Drag to float · drag onto another screen to pop out',
  'bottomStrip.tabListAriaLabel': 'Open bottom panels',
  'bottomStrip.closeTabAriaLabel': 'Close {name}',
  'bottomStrip.maximize': 'Maximize',
  'bottomStrip.restore': 'Restore',
  'bottomStrip.close': 'Close',
  // Side-by-side 2D/3D layout preset (#5515) — Drawing-only toggle.
  'bottomStrip.dockBeside': 'Dock beside 3D view',
  'bottomStrip.dockBelow': 'Dock below 3D view',

  // ---- SaveMarkupToModelButton.tsx -------------------------------------------
  'saveMarkupToModelButton.menuItemLabel': 'Save Markup to Model',

  // ---- ExportChangesButton.tsx -----------------------------------------------
  'exportChangesButton.buttonLabel': 'Export modified IFC…',
  'exportChangesButton.tooltipMulti': 'Export changes in {models} models ({count} changes)',
  'exportChangesButton.tooltipSingle': {
    one: 'Export IFC with {count} change applied',
    other: 'Export IFC with {count} changes applied',
  },

  // ---- SearchableSelect.tsx ---------------------------------------------------
  'searchableSelect.defaultPlaceholder': 'Select...',
  'searchableSelect.searchPlaceholder': 'Search...',
  'searchableSelect.noMatches': 'No matches',
} satisfies Record<string, TranslationValue>;
