/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * The zones/rooms slice (#4918 zones slice, `zonesPanel.*`) covers five
 * files: `ZonesPanel.tsx` (author + manage location zones, issue #1810),
 * its two straddler-volume companions `ZoneApportionSummary.tsx` and
 * `ZoneVolumeBreakdown.tsx` (issue #2508), the export/write-back surface
 * `ZoneWriteBackControl.tsx`, and the unrelated-by-domain but grouped-by-
 * this-slice `RoomPanel.tsx` (the collaboration room roster — "room" here
 * means a live collab session, not an IFC spatial room). Zone NAMES the
 * user assigns, generated-set default names ('Untitled set', 'Storeys')
 * that become renamable data the instant they are created, export file
 * names, and peer/user display names remain runtime content and stay out
 * of the catalogue. `STATUS_META`/`SEEDING_META` (connection-status dot)
 * and `ROLE_META` (collab role badge) in `RoomPanel.tsx` moved to the same
 * data-table-plus-`labelKey` pattern `sectionConstants.ts`'s `AXIS_INFO`
 * and the clash-panel severity/review-status tables use; `ZoneRow`'s
 * Center/Size field-label tuples in `ZonesPanel.tsx` moved to arrays of
 * translation keys for the same reason. Multi-clause status lines built
 * from independent optional counts (the apportionment coverage footer, the
 * geometry-export success toast) render each clause as its own translated
 * span/branch joined by a plain, letter-free ' · ' separator rather than
 * concatenating translated fragments in code, the same reasoning
 * `ClashRevisionCompareDialog.tsx`'s `warningLines()` and the layers
 * catalogue's `checkEvidence.summary` already document.
 */
export const zonesPanelEn = {
  // ZonesPanel — ZoneRow field labels (data-table-plus-labelKey)
  'zonesPanel.zoneRow.centerXLabel': 'Center X',
  'zonesPanel.zoneRow.centerYLabel': 'Center Y',
  'zonesPanel.zoneRow.centerZLabel': 'Center Z',
  'zonesPanel.zoneRow.widthLabel': 'Width (X)',
  'zonesPanel.zoneRow.heightLabel': 'Height (Y)',
  'zonesPanel.zoneRow.depthLabel': 'Depth (Z)',
  'zonesPanel.zoneRow.rotationLabel': 'Rotation (°)',
  'zonesPanel.zoneRow.baseYLabel': 'Base (Y)',
  'zonesPanel.zoneRow.prismHeightLabel': 'Height (Y)',

  // ZonesPanel — ZoneRow controls
  'zonesPanel.zoneRow.stopEditingTitle': 'Stop editing in 3D',
  'zonesPanel.zoneRow.editIn3dTitle': 'Edit in 3D (move / resize / rotate handles)',
  'zonesPanel.zoneRow.selectTitle': 'Select elements in this zone',
  'zonesPanel.zoneRow.exportingTitle': "Cutting this zone's geometry, this can take a while",
  'zonesPanel.zoneRow.exportGeometryTitle': "Export this zone's geometry (boundary-crossing elements cut at the boundary) as GLB",
  'zonesPanel.zoneRow.exportGeometryAriaLabel': 'Export {name} geometry',
  'zonesPanel.zoneRow.cuttingProgress': 'Cutting {done}/{total}',
  'zonesPanel.zoneRow.deleteZoneTitle': 'Delete zone',
  'zonesPanel.zoneRow.footprintTitle': 'Footprint imported from JSON; the 3D handles edit boxes only',
  'zonesPanel.zoneRow.prismPts': 'prism, {count} pts',

  // ZonesPanel — header / set list chrome
  'zonesPanel.header.title': 'Location zones',
  'zonesPanel.header.newSetPlaceholder': 'New zone set name…',
  'zonesPanel.header.addSetButton': 'Set',
  'zonesPanel.header.generateFromStoreysButton': 'Generate from storeys',
  'zonesPanel.header.exportSetsTitle': 'Export zone sets as JSON',
  'zonesPanel.header.importSetsTitle': 'Import zone sets from JSON',
  'zonesPanel.emptyState': "No zone sets yet. Create one above, or generate one from the model's storeys.",
  'zonesPanel.zoneCount': { one: '{count} zone', other: '{count} zones' },
  'zonesPanel.hideIn3dTitle': 'Hide in 3D view',
  'zonesPanel.showIn3dTitle': 'Show in 3D view',
  'zonesPanel.addZoneTitle': 'Add zone',
  'zonesPanel.deleteZoneSetTitle': 'Delete zone set',
  'zonesPanel.setNamePlaceholder': 'Set name',
  'zonesPanel.assignmentTimingLine': 'Last assignment: {elementCount} element(s) x {zoneSetCount} set(s) in {elapsedMs}ms',

  // ZonesPanel — toasts / status messages
  'zonesPanel.generateFromStoreysError': 'Could not generate zones from storeys: {error}',
  'zonesPanel.generateFromStoreysSuccess': { one: 'Generated {count} zone from storeys', other: 'Generated {count} zones from storeys' },
  'zonesPanel.importFailed': 'Import failed: {error}',
  'zonesPanel.importSuccess': 'Zone sets imported',
  'zonesPanel.selectedElements': { one: 'Selected {count} element', other: 'Selected {count} elements' },
  'zonesPanel.noElementsInZone': 'No elements in this zone',
  'zonesPanel.exportZoneError': 'Could not export {name}: {message}',
  'zonesPanel.exportNoBinding': 'The geometry engine in this build cannot split meshes',
  'zonesPanel.exportBusy': 'Another zone is still being cut. Wait for it to finish.',
  'zonesPanel.exportNothingToExport': 'Nothing to export: no loaded geometry reaches this zone',
  'zonesPanel.exportGeometrySuccessPlain': 'Exported {whole} whole and {cut} cut element(s) in {elapsed}s',
  'zonesPanel.exportGeometrySuccessRefusedOnly':
    'Exported {whole} whole and {cut} cut element(s) in {elapsed}s, {refused} not cut (mesh not a proven closed solid, or the pieces did not add up)',
  'zonesPanel.exportGeometrySuccessNoGeometryOnly':
    'Exported {whole} whole and {cut} cut element(s) in {elapsed}s, {noGeometry} with no loaded geometry',
  'zonesPanel.exportGeometrySuccessBoth':
    'Exported {whole} whole and {cut} cut element(s) in {elapsed}s, {refused} not cut (mesh not a proven closed solid, or the pieces did not add up), {noGeometry} with no loaded geometry',

  // ZoneApportionSummary
  'zonesPanel.apportionSummary.noStraddlersTitle': 'No element crosses a boundary in this set, so there is nothing to split',
  'zonesPanel.apportionSummary.splitTitle': {
    one: "Split the volume of {count} straddling element across this set's zones",
    other: "Split the volume of {count} straddling elements across this set's zones",
  },
  'zonesPanel.apportionSummary.splitVolumesButton': {
    one: 'Split volumes ({count} boundary-crossing element)',
    other: 'Split volumes ({count} boundary-crossing elements)',
  },
  'zonesPanel.apportionSummary.splitSummary': '{count} split in {ms} ms',
  'zonesPanel.apportionSummary.unprovedSolidClause': '{count} skipped (mesh not a proven closed solid)',
  'zonesPanel.apportionSummary.noGeometryClause': '{count} skipped (no geometry loaded)',
  'zonesPanel.apportionSummary.rescaledClause': '{count} skipped (model rescaled by federation alignment)',

  // ZoneVolumeBreakdown
  'zonesPanel.volumeBreakdown.outsideZoneLabel': 'in no zone',
  'zonesPanel.volumeBreakdown.noGeometryMessage': 'No geometry loaded for this element, so its volume cannot be split.',
  'zonesPanel.volumeBreakdown.unprovedSolidMessage': 'Its mesh is not a proven closed solid, so no volume can be stated for it — let alone split.',
  'zonesPanel.volumeBreakdown.rescaledMessage':
    "Federation alignment rescaled this element's model, so its proved volume no longer describes the geometry on screen. Re-anchor the federation on this model to split it.",
  'zonesPanel.volumeBreakdown.unknownReasonMessage': 'Its volume could not be split ({reason}).',
  'zonesPanel.volumeBreakdown.splitButton': 'Split volume by zone',
  'zonesPanel.volumeBreakdown.overlapWarning': 'These zones overlap each other, so the shares double-count and do not add up to the whole.',

  // ZoneWriteBackControl
  'zonesPanel.writeBack.volumeBasisAriaLabel': 'Volume basis',
  'zonesPanel.writeBack.writeButtonTitle': "Write this set's zone assignment onto the elements as {psetName}",
  'zonesPanel.writeBack.writeButtonLabel': 'Write to model',
  'zonesPanel.writeBack.removePropsTitle': 'Remove {psetName} from every element of this set',
  'zonesPanel.writeBack.removePropsAriaLabel': 'Remove zone properties',
  'zonesPanel.writeBack.downloadTableTitle': 'Download the per-element breakdown for this set as {format}, one row per element and zone',
  'zonesPanel.writeBack.buildingLabel': 'Building...',
  'zonesPanel.writeBack.emitZonesTitle': 'Emit the zones themselves as IfcSpatialZone entities, each referencing the elements it contains',
  'zonesPanel.writeBack.emitZonesLabel': 'Write zones to IFC',
  'zonesPanel.writeBack.removeEmittedTitle': 'Remove the IfcSpatialZone entities emitted for this set',
  'zonesPanel.writeBack.removeEmittedAriaLabel': 'Remove emitted spatial zones',
  'zonesPanel.writeBack.noMembersTableMessage': 'No element is in a zone of this set, so the table would be empty',
  'zonesPanel.writeBack.tableExportSuccess': 'Exported {rows} row(s) for {elements} element(s)',
  'zonesPanel.writeBack.tableExportSuccessUnmeasured': 'Exported {rows} row(s) for {elements} element(s), {unmeasured} with no volume and a stated reason',
  'zonesPanel.writeBack.tableExportError': 'Could not export the table: {message}',
  'zonesPanel.writeBack.collabReadOnlyWrite': 'Your role in this session is read-only, so nothing was written',
  'zonesPanel.writeBack.duplicateSetNameWrite': 'Another zone set is also called "{name}". Rename one before writing.',
  'zonesPanel.writeBack.noMembersWrite': 'No element is in a zone of this set, so nothing was written',
  'zonesPanel.writeBack.writeSuccess': 'Wrote {written} element(s): {withVolumes} with volumes',
  'zonesPanel.writeBack.writeSuccessRefused': 'Wrote {written} element(s): {withVolumes} with volumes, {refused} with a stated reason instead',
  'zonesPanel.writeBack.collabReadOnlyRemove': 'Your role in this session is read-only, so nothing was removed',
  'zonesPanel.writeBack.duplicateSetNameRemove': 'Another zone set is also called "{name}". Rename one before removing.',
  'zonesPanel.writeBack.nothingToRemove': 'Nothing to remove for this set',
  'zonesPanel.writeBack.removeSuccess': 'Removed the zone property set from {removed} element(s)',
  'zonesPanel.writeBack.collabReadOnlyEmit': 'Your role in this session is read-only, so nothing was emitted',
  'zonesPanel.writeBack.duplicateSetNameEmit': 'Another zone set is also called "{name}". Rename one before emitting.',
  'zonesPanel.writeBack.staleRemovedOnly': 'No element is in a zone of this set any more, so {staleRemoved} emitted zone(s) were removed',
  'zonesPanel.writeBack.noMembersEmit': 'No element is in a zone of this set, so there is nothing to reference',
  'zonesPanel.writeBack.noModelForZones': 'No loaded model could take the zones',
  'zonesPanel.writeBack.emitSuccess': 'Emitted {zones} IfcSpatialZone(s) across {models} model(s), referencing {elements} element(s)',
  'zonesPanel.writeBack.emitSuccessReplaced': 'Emitted {zones} IfcSpatialZone(s) across {models} model(s), referencing {elements} element(s), replacing {replaced} from an earlier run',
  'zonesPanel.writeBack.emitSuccessStale': 'Emitted {zones} IfcSpatialZone(s) across {models} model(s), referencing {elements} element(s), and clearing {staleRemoved} from a model this set no longer reaches',
  'zonesPanel.writeBack.emitSuccessReplacedStale':
    'Emitted {zones} IfcSpatialZone(s) across {models} model(s), referencing {elements} element(s), replacing {replaced} from an earlier run, and clearing {staleRemoved} from a model this set no longer reaches',
  'zonesPanel.writeBack.removeEmittedNone': 'No emitted zones to remove for this set',
  'zonesPanel.writeBack.removeEmittedSuccess': 'Removed {removed} IfcSpatialZone(s)',

  // RoomPanel — status/role data tables (data-table-plus-labelKey)
  'zonesPanel.roomPanel.status.live': 'Live',
  'zonesPanel.roomPanel.status.syncing': 'Syncing',
  'zonesPanel.roomPanel.status.connecting': 'Connecting',
  'zonesPanel.roomPanel.status.local': 'Local',
  'zonesPanel.roomPanel.status.offline': 'Offline',
  'zonesPanel.roomPanel.status.uploading': 'Uploading',
  'zonesPanel.roomPanel.role.admin': 'Admin',
  'zonesPanel.roomPanel.role.editor': 'Editor',
  'zonesPanel.roomPanel.role.commenter': 'Comment',
  'zonesPanel.roomPanel.role.viewer': 'Viewer',

  // RoomPanel — chrome
  'zonesPanel.roomPanel.youSuffix': '(you)',
  'zonesPanel.roomPanel.selectedCount': '{count} selected',
  'zonesPanel.roomPanel.jumpToAriaLabel': "Jump to {name}'s view",
  'zonesPanel.roomPanel.jumpToTooltip': 'Jump to view',
  'zonesPanel.roomPanel.removePeerAriaLabel': 'Remove {name}',
  'zonesPanel.roomPanel.removeFromRoomTooltip': 'Remove from session',
  'zonesPanel.roomPanel.emptyTitle': 'Work on this model together',
  'zonesPanel.roomPanel.emptyDescription': 'Create a session to edit live with others: shared cursors, presence, and every edit synced. Invites are one link.',
  'zonesPanel.roomPanel.createRoomButton': 'Create a session',
  'zonesPanel.roomPanel.inviteHint': "Got an invite? Just open the link - it lands you in the session.",
  'zonesPanel.roomPanel.rootAriaLabel': 'Collaboration session',
  'zonesPanel.roomPanel.uploadingModel': 'Uploading model',
  'zonesPanel.roomPanel.statusRoom': '{status} session',
  'zonesPanel.roomPanel.onlyOneHereMessage': "You're the only one here. Copy the link to invite others.",
  'zonesPanel.roomPanel.copyLinkUnavailableTitle': 'Available once the upload finishes',
  'zonesPanel.roomPanel.linkCopied': 'Link copied',
  'zonesPanel.roomPanel.copyInviteLinkLabel': 'Copy invite link',
  'zonesPanel.roomPanel.revokedLabel': 'Revoked',
  'zonesPanel.roomPanel.revokeLinkLabel': 'Revoke link',
  'zonesPanel.roomPanel.revokeLinkTooltip': 'Invalidate the current share link',
  'zonesPanel.roomPanel.leaveAbandonsUploadLabel': 'Leave (abandons upload)',
  'zonesPanel.roomPanel.leaveRoomLabel': 'Leave session',
  'zonesPanel.roomPanel.copyLinkFailed': 'Could not copy the invite link. Check the connection and clipboard access, then try again.',
  'zonesPanel.roomPanel.revokeLinkFailed': 'Could not revoke the share link. Links you already shared still work.',
  'zonesPanel.roomPanel.removePeerFailed': 'Could not remove {name} from the session. Try again.',
  'zonesPanel.header.closeLabel': 'Close location zones',
} as const satisfies Record<string, TranslationValue>;
