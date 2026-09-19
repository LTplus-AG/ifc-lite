/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * The Properties panel's own chrome (#4918 slice 4): the entity header
 * actions, the assembly/spatial-location badges, and the small info cards
 * (property sets, quantity sets, materials, classification, documents,
 * relationships, schedule, structural, raw STEP, bSDD, model metadata).
 * Georeferencing-related panels have their own `georeferencing.en.ts`
 * catalogue. Property/pset/material/classification NAMES are model
 * content, not literals, and stay out of this catalogue.
 */
export const propertiesEn = {
  // AssemblyBadge
  'properties.assemblyBadge.tooltip': 'Select the parent assembly',
  'properties.assemblyBadge.label': 'Part of Assembly',

  // SpatialLocationBadge
  'properties.spatialLocation.elevationDisplay': '{sign}{value}m',
  'properties.spatialLocation.elevationTooltip': 'Elevation: {sign}{value}m from ground',
  'properties.spatialLocation.heightTooltip': 'Height: {value}m to next storey',

  // Shared field-row labels, reused across ClassificationCard, DocumentCard
  // and any other card rendering the same generic "label / value" row.
  'properties.field.identification': 'Identification',
  'properties.field.name': 'Name',
  'properties.field.system': 'System',
  'properties.field.location': 'Location',
  'properties.field.path': 'Path',
  'properties.field.description': 'Description',
  'properties.field.purpose': 'Purpose',
  'properties.field.intendedUse': 'Intended Use',
  'properties.field.revision': 'Revision',

  // ClassificationCard
  'properties.classification.unresolved': 'Classification present, but unavailable on this data source',
  'properties.classification.heading': 'Classification',
  'properties.classification.unknown': 'Unknown',

  // DocumentCard
  'properties.document.heading': 'Document',

  // RelationshipsCard
  'properties.relationships.heading': 'Relationships',
  'properties.relationships.openings': 'Openings ({count})',
  'properties.relationships.fills': 'Fills ({count})',
  'properties.relationships.groupsAndZones': 'Groups & Zones ({count})',
  'properties.relationships.connections': 'Connections ({count})',
  'properties.relationships.groupFallbackName': 'Group #{id}',
  'properties.relationships.showGroupAttributesTooltip': "Show this group's attributes",
  'properties.relationships.isolateGroupMembersTooltip': "Isolate this group's members in 3D",

  // StructuralCard
  'properties.structural.heading': 'Structural Analysis',
  'properties.structural.loadsTruncatedTooltip':
    'One or more applied loads were bounded during extraction — this member may carry more load data than shown',
  'properties.structural.truncatedBadge': 'Truncated',
  'properties.structural.predefined': 'Predefined',
  'properties.structural.thickness': 'Thickness',
  'properties.structural.model': 'Model',
  'properties.structural.connections': 'Connections ({count})',
  'properties.structural.appliedLoads': 'Applied loads ({count})',

  // FederationAlignmentControls
  'properties.federationAlignment.anchor': 'Federation anchor',
  'properties.federationAlignment.sameCrs': 'Aligned (same CRS)',
  'properties.federationAlignment.reprojected': 'Reprojected to anchor CRS',
  'properties.federationAlignment.identity': 'Aligned (identity)',
  'properties.federationAlignment.failed': 'Alignment failed',
  'properties.federationAlignment.notAligned': 'Not aligned',
  'properties.federationAlignment.makeAnchorTooltip': "Use this model as the federation anchor. Click 'Re-align' afterwards to apply.",
  'properties.federationAlignment.makeAnchor': 'Make anchor',
  'properties.federationAlignment.unpinTooltip': 'Stop pinning this model as the anchor; revert to the default (earliest-loaded with georef).',
  'properties.federationAlignment.unpin': 'Unpin',
  'properties.federationAlignment.realignTooltip': "Re-bake every model's geometry against the current anchor.",
  'properties.federationAlignment.realign': 'Re-align',
  'properties.federationAlignment.realignFailedWithMessage': 'Re-align failed: {message}',
  'properties.federationAlignment.realignFailed': 'Re-align failed.',

  // EntityHeaderActions
  'properties.entityHeaderActions.zoomTo': 'Zoom to',
  'properties.entityHeaderActions.clearShowInContext': 'Clear "show in context"',
  'properties.entityHeaderActions.showInContext': 'Show in context (fade the rest, keep it visible)',
  'properties.entityHeaderActions.hide': 'Hide',
  'properties.entityHeaderActions.show': 'Show',

  // PropertySetCard
  'properties.propertySetCard.newPsetTooltip': 'New property set (not in original model)',
  'properties.propertySetCard.hasMutationsTooltip': 'Has modified properties',
  'properties.propertySetCard.inheritedFromTypeTooltip': 'Inherited from type — edits apply to all instances of this type',
  'properties.propertySetCard.editedBadge': 'edited',
  'properties.propertySetCard.propertyModifiedTooltip': 'This property has been modified',

  // UnitDisplayControl
  'properties.unitDisplay.trigger': 'Display units',
  'properties.unitDisplay.fileUnit': 'File unit',
  'properties.unitDisplay.resetToFileUnits': 'Reset to file units',
  'properties.unitDisplay.kind.length': 'Length',
  'properties.unitDisplay.kind.area': 'Area',
  'properties.unitDisplay.kind.volume': 'Volume',
  'properties.unitDisplay.kind.mass': 'Mass',
  'properties.unitDisplay.kind.time': 'Time',
  'properties.unitDisplay.kind.angle': 'Angle',
  'properties.unitDisplay.kind.flowRate': 'Flow rate',
  'properties.unitDisplay.kind.massFlowRate': 'Mass flow rate',
  'properties.unitDisplay.kind.pressure': 'Pressure',
  'properties.unitDisplay.kind.power': 'Power',
  'properties.unitDisplay.kind.energy': 'Energy',
  'properties.unitDisplay.kind.velocity': 'Velocity',
  'properties.unitDisplay.kind.frequency': 'Frequency',
  'properties.unitDisplay.kind.temperature': 'Temperature',
  'properties.unitDisplay.kind.density': 'Density',
  'properties.unitDisplay.kind.force': 'Force',

  // EpsgLookupDialog
  'properties.epsgLookup.triggerButton': 'EPSG',
  'properties.epsgLookup.title': 'EPSG Lookup',
  'properties.epsgLookup.description': 'Search by code, name, country, or datum',
  'properties.epsgLookup.searchPlaceholder': 'e.g. 2056, UTM, Switzerland, Tokyo...',
  'properties.epsgLookup.noResults': 'No coordinate reference systems found',
  'properties.epsgLookup.searchUnavailable': 'Search unavailable',

  // MaterialTotalsPanel
  'properties.materialTotals.fallbackName': 'Material #{id}',
  'properties.materialTotals.totalsHeading': 'Totals',
  'properties.materialTotals.elements': 'Elements',
  'properties.materialTotals.volume': 'Volume',
  'properties.materialTotals.area': 'Area',
  'properties.materialTotals.weight': 'Weight',
  'properties.materialTotals.noVolumeQuantities': 'No volume quantities (Qto_*) found on these elements.',
  'properties.materialTotals.partialVolumeNote':
    'Volume from {counted} of {total} elements with reported quantities; multi-material elements are split by layer thickness / constituent fraction.',
  'properties.materialTotals.byClassHeading': 'By Class',
  'properties.materialTotals.materialPropertiesHeading': 'Material Properties',
  'properties.materialTotals.noData': 'No data for this material',

  // RawStepRow
  'properties.rawStepRow.positionalIndexAriaLabel': 'positional index {index}',
  'properties.rawStepRow.drillIntoTooltip': 'Drill into {token} (auto-skips trivial wrappers)',
  'properties.rawStepRow.clickToEditTooltip': 'Click to edit',
  'properties.rawStepRow.notInlineEditableTooltip': 'This value type is not inline-editable',
  'properties.rawStepRow.overlayOverrideAriaLabel': 'overlay override active',
  'properties.rawStepRow.overlayOverrideTooltip': 'Overlay override',
  'properties.rawStepRow.saveTooltip': 'Save (Enter)',
  'properties.rawStepRow.cancelTooltip': 'Cancel (Esc)',
  'properties.rawStepRow.editTooltip': 'Edit',

  // PrecisionGridBadge
  'properties.precisionGrid.loadedBadge': 'grid',
  'properties.precisionGrid.loadedTooltip': 'Precision NTv2/GeoTIFF grid loaded for {region}.',
  'properties.precisionGrid.loadedDetail': 'Sub-decimeter datum-shift accuracy via {filename}.',
  'properties.precisionGrid.failedBadge': 'grid failed',
  'properties.precisionGrid.failedTooltip': 'Precision grid fetch failed for {region}.',
  'properties.precisionGrid.failedDetail': 'Falling back to +towgs84 approximation. Check network access to {host}.',
  'properties.precisionGrid.loadingBadge': 'loading grid',
  'properties.precisionGrid.loadingTooltip': 'Fetching precision grid for {region}…',
  'properties.precisionGrid.loadingDetail':
    'Until it arrives, placement uses the +towgs84 approximation (off by up to ~120 m for this CRS).',

  // BsddCard
  'properties.bsdd.fetchFailed': 'Failed to fetch bSDD data',
  'properties.bsdd.addedSingleWithFollowUp': 'Added "{name}" — open Properties to set its value',
  'properties.bsdd.addedSingle': 'Added "{name}"',
  'properties.bsdd.addedMany': { one: 'Added {count} {pset} property', other: 'Added {count} {pset} properties' },
  'properties.bsdd.addedManyWithFollowUp': {
    one: 'Added {count} {pset} property — open Properties to set values',
    other: 'Added {count} {pset} properties — open Properties to set values',
  },
  'properties.bsdd.loading': 'Loading bSDD data for {entityType}...',
  'properties.bsdd.loadFailed': 'Could not load bSDD data: {error}',
  'properties.bsdd.noData': 'No bSDD data available for {entityType}',
  'properties.bsdd.editedCount': '{count} added · Edit in Properties',
  'properties.bsdd.addAllTooltip': 'Add all {count} properties',
  'properties.bsdd.addToElementTooltip': 'Add to element',
  'properties.bsdd.viewOnBsdd': 'View on bSDD',

  // ScheduleCard
  'properties.schedule.heading': 'Construction Schedule',
  'properties.schedule.pendingTooltip': 'Pending schedule edits — included on IFC export',
  'properties.schedule.pendingBadge': 'Pending',
  'properties.schedule.taskCount': { one: '{count} task', other: '{count} tasks' },
  'properties.schedule.generatedLocallyNote': 'Generated locally — will be spliced into the next IFC export.',
  'properties.schedule.start': 'Start',
  'properties.schedule.finish': 'Finish',
  'properties.schedule.duration': 'Duration',
  'properties.schedule.complete': 'Complete',
  'properties.schedule.schedule': 'Schedule',

  // MaterialCard
  'properties.material.typeLabel.material': 'Material',
  'properties.material.typeLabel.layerSet': 'Layer Set',
  'properties.material.typeLabel.profileSet': 'Profile Set',
  'properties.material.typeLabel.constituentSet': 'Constituent Set',
  'properties.material.typeLabel.materialList': 'Material List',
  'properties.material.setName': 'Set Name',
  'properties.material.layerN': 'Layer {n}',
  'properties.material.profileN': 'Profile {n}',
  'properties.material.constituentN': 'Constituent {n}',
  'properties.material.materialN': 'Material {n}',
  'properties.material.materialLabel': 'Material',
  'properties.material.categoryLabel': 'Category',
  'properties.material.ventilatedLabel': 'Ventilated',
  'properties.material.yes': 'Yes',

  // RawStepCard
  'properties.rawStep.noPositionalArgs': 'Entity #{id} has no positional STEP arguments',
  'properties.rawStep.unavailable': 'Raw STEP is unavailable for this model',
  'properties.rawStep.backToRoot': '← Back to {type} #{id}',
  'properties.rawStep.backOneStepTooltip': 'Back one step',
  'properties.rawStep.back': 'back',
  'properties.rawStep.backToSelectedTooltip': 'Back to selected entity {type} #{id}',
  'properties.rawStep.overlayAddedTooltip': 'This entity was added through the overlay (bim.store.addEntity / addColumn).',
  'properties.rawStep.newBadge': 'New',
  'properties.rawStep.argN': 'Arg {n}',
  'properties.rawStep.footerHelp':
    'STEP literals: numbers, $ for null, .T./.F. for booleans, #42 for refs (click to drill), .AREA. for enums. Edits land on the export overlay — undo/redo via the toolbar.',

  // ModelMetadataPanel
  'properties.modelMetadata.ifcModel': 'IFC Model',
  'properties.modelMetadata.fileInformationHeading': 'File Information',
  'properties.modelMetadata.fileSize': 'File Size',
  'properties.modelMetadata.loadedAt': 'Loaded At',
  'properties.modelMetadata.parseTime': 'Parse Time',
  'properties.modelMetadata.parseTimeValue': '{ms} ms',
  'properties.modelMetadata.lengthUnitHeading': 'Length Unit',
  'properties.modelMetadata.lengthUnitValue': '{unitName} ({scale})',
  'properties.modelMetadata.unit.meters': 'Meters',
  'properties.modelMetadata.unit.millimeters': 'Millimeters',
  'properties.modelMetadata.unit.centimeters': 'Centimeters',
  'properties.modelMetadata.unit.inches': 'Inches',
  'properties.modelMetadata.unit.feet': 'Feet',
  'properties.modelMetadata.projectInformationHeading': 'Project Information',
  'properties.modelMetadata.globalIdLabel': 'GlobalId',
  'properties.modelMetadata.statisticsHeading': 'Statistics',
  'properties.modelMetadata.totalEntities': 'Total Entities',
  'properties.modelMetadata.notAvailable': 'N/A',
  'properties.modelMetadata.buildingStoreys': 'Building Storeys',
  'properties.modelMetadata.elementsWithGeometry': 'Elements with Geometry',
  'properties.modelMetadata.maxExpressId': 'Max Express ID',
  'properties.modelMetadata.classificationSystemsHeading': 'Classification Systems',
  'properties.modelMetadata.classificationUnresolved': 'Classification systems present, but unavailable on this data source',
  'properties.modelMetadata.noClassificationSystems': 'No classification systems',

  // TaskEditCard
  'properties.taskEdit.heading': 'Edit task',
  'properties.taskEdit.pendingBadge': '● Pending',
  'properties.taskEdit.nameLabel': 'Name',
  'properties.taskEdit.namePlaceholder': 'Untitled task',
  'properties.taskEdit.predefinedTypeLabel': 'Predefined type',
  'properties.taskEdit.milestoneLabel': 'Milestone',
  'properties.taskEdit.startLabel': 'Start',
  'properties.taskEdit.finishLabel': 'Finish',
  'properties.taskEdit.durationLabel': 'Duration (days)',
  'properties.taskEdit.timeConsistencyHelp':
    'Editing start or duration keeps finish consistent; editing finish keeps start consistent.',
  'properties.taskEdit.productsLabel': 'Products',
  'properties.taskEdit.productsAssignedCount': '{count} assigned',
  'properties.taskEdit.addButton': 'Add',
  'properties.taskEdit.addButtonWithCount': 'Add ({count})',
  'properties.taskEdit.addTooltipWithCount': 'Add the {count} object(s) currently selected in the 3D viewport to this task.',
  'properties.taskEdit.addTooltipEmpty': 'Select objects in the 3D viewport first.',
  'properties.taskEdit.removeButton': 'Remove',
  'properties.taskEdit.removeButtonWithCount': 'Remove ({count})',
  'properties.taskEdit.removeTooltip': 'Remove the selected 3D objects from this task.',
  'properties.taskEdit.detailsToggle': 'Details',
  'properties.taskEdit.identificationLabel': 'Identification',
  'properties.taskEdit.globalIdLabel': 'Global ID',
  'properties.taskEdit.deleteTaskButton': 'Delete task',
  'properties.taskEdit.confirmDelete': 'Delete?',
  'properties.taskEdit.confirmDeleteWithDescendants': 'Delete + {count} descendants?',
  'properties.taskEdit.cancel': 'Cancel',
  'properties.taskEdit.delete': 'Delete',

  // LocationMap
  'properties.locationMap.kmzExportFailedWithReason': 'KMZ export failed: {reason}',
  'properties.locationMap.kmzExportFailedUnknown': 'KMZ export failed: {message}',
  'properties.locationMap.unknownError': 'Unknown error',
  'properties.locationMap.heading': 'Location',
  'properties.locationMap.searchTooltip': 'Search for a place',
  'properties.locationMap.searchPlaceholder': 'Search for a place...',
  'properties.locationMap.resolvingCoordinates': 'Resolving coordinates...',
  'properties.locationMap.unavailableOnDevice': 'Map preview unavailable on this device',
  'properties.locationMap.mapLoadFailed': 'The map component could not be loaded. Check your connection and reload the page.',
  'properties.locationMap.graphicsUnavailable':
    'Your browser could not provide graphics for the map. Coordinates, search and the links below still work; reloading the page may restore it.',
  'properties.locationMap.clickToPlacePin': 'Click map to place pin',
  'properties.locationMap.newPosition': 'New Position',
  'properties.locationMap.removePinTooltip': 'Remove pin',
  'properties.locationMap.latLon': 'Lat/Lon',
  'properties.locationMap.easting': 'Easting',
  'properties.locationMap.northing': 'Northing',
  'properties.locationMap.elevation': 'Elevation',
  'properties.locationMap.applyToEastingsNorthings': 'Apply to Eastings / Northings',
  'properties.locationMap.applyToEastingsNorthingsHeight': 'Apply to Eastings / Northings / Height',
  'properties.locationMap.googleMaps': 'Google Maps',
  'properties.locationMap.googleMapsTooltip': 'Open model location in Google Maps',
  'properties.locationMap.openStreetMap': 'OpenStreetMap',
  'properties.locationMap.openStreetMapTooltip': 'Open model location in OpenStreetMap',
  'properties.locationMap.googleEarth': 'Google Earth',
  'properties.locationMap.googleEarthTooltip':
    'Download KMZ for Google Earth Pro (desktop), placed at the model location. Google Earth on the web cannot show KMZ 3D models — use Export GLB for the web.',
  'properties.locationMap.toggleStyle': 'Toggle style',
  'properties.locationMap.projectionUnresolved': 'Could not resolve projection — EPSG code may be unsupported',
  'properties.locationMap.elevationMeters': '{value} m',

  // GeoreferencingPanel: GeorefRow / AngleRow
  'properties.georef.computedTooltip': 'Computed from XAxisAbscissa and XAxisOrdinate',
  'properties.georef.editedBadge': 'edited',
  'properties.georef.selectPlaceholder': '-- select --',
  'properties.georef.angleEditTooltip': 'Edit angle to auto-compute XAxisAbscissa/XAxisOrdinate',
  'properties.georef.angleToGridNorth': 'Angle to Grid North',
  'properties.georef.degUnit': 'deg',
  'properties.georef.angleSetsAxesNote': 'Sets XAxisAbscissa = cos(angle), XAxisOrdinate = sin(angle)',

  // GeoreferencingPanel: main panel
  'properties.georef.noGeoreferencing': 'No georeferencing',
  'properties.georef.addGeoreferencing': 'Add Georeferencing',
  'properties.georef.reloadPrompt': 'Georeference saved. Reload loaded models to recompute 3D alignment?',
  'properties.georef.reloadModels': 'Reload models',
  'properties.georef.later': 'Later',
  'properties.georef.legacySiteNotice': 'Showing legacy IfcSite geolocation from IFC2X3. This view is read-only.',
  'properties.georef.unsupportedSchemaNotice': 'Georeferencing editing requires IFC4 or newer. IFC2X3 does not support IfcProjectedCRS or IfcMapConversion.',
  'properties.georef.noProjectedCrs': 'No projected CRS',
  'properties.georef.epsgButton': 'EPSG',
  'properties.georef.doubleGeorefHeading': 'This model is georeferenced twice. ifc-lite corrected it.',
  'properties.georef.doubleGeorefBody':
    'The geometry already sits at map coordinates (E {eastingValue} N {northingValue}), and this IfcMapConversion repeats the same offset. ifc-lite places the geometry where it already is; a tool that applied the conversion on top would put the model {displacement} away.',
  'properties.georef.rotationOverrideNote':
    'This file also authors a map rotation that cannot be reconciled with its own coordinates, so the model is placed grid-aligned. Check the orientation, and set Angle to Grid North by hand if it looks wrong.',
  'properties.georef.rawValuesNote':
    "The file's own values are shown below exactly as authored. The export is worth fixing at source; to bake the correction in here, {instruction}",
  'properties.georef.projectedCrsHeading': 'Projected CRS',
  'properties.georef.missingCrsNotice': 'Coordinate operation exists, but projected CRS is missing.',
  'properties.georef.addCrs': 'Add CRS',
  'properties.georef.coordinateOperationHeading': 'Coordinate Operation',
  'properties.georef.scaleInconsistentAriaLabel': 'Scale inconsistent with project/map units',
  'properties.georef.scaleInconsistentTooltip': 'Scale inconsistent with project/map units — expand to view details',
  'properties.georef.eastingNorthingSummary': 'E {easting} N {northing}',
  'properties.georef.scaleAttributeInconsistent': '{attribute} inconsistent with project/map units.',
  'properties.georef.scaleCompensatedNote':
    'Per IFC schema, IfcMapConversion.Scale (times the IfcMapConversionScaled factor on each axis) should bridge the unit difference between the project length unit and map CRS unit. Current {attribute} = {authoredValue}; expected ≈ {expectedValue}.',
  'properties.georef.scaleCompensatedDetail':
    'ifc-lite compensates and places the geometry at 1× — no action needed here, but a tool that follows the schema strictly will render this file at {specEffectiveScale}× its physical size.',
  'properties.georef.scaleUncompensatedDetail':
    'Geometry is being placed at {effectiveScale}× its physical size — adjust {fixAttribute} to fix.',
  'properties.georef.scaleFixAttributeScale': 'Scale (or MapUnit)',
  'properties.georef.noConversionNotice': 'No coordinate operation. Add map coordinates, angle to grid north, and scale.',
  'properties.georef.addCoordinates': 'Add Coordinates',
  'properties.georef.visibleSurfaceHeight': 'Visible surface height',
  'properties.georef.heightMeters': '{value} m',
  'properties.georef.queryingEllipsis': 'querying...',
  'properties.georef.sampledVia': 'sampled via {source}',
  'properties.georef.setOrthogonalHeightButton': 'Set OrthogonalHeight to sampled terrain height ({value} m)',
  'properties.georef.heightsEllipsoidalLabel': 'Heights are ellipsoidal (skip geoid correction)',
  'properties.georef.heightsEllipsoidalHelp':
    'Off by default: OrthogonalHeight is treated as orthometric and the geoid undulation is added so the model is not buried under terrain.',
  'properties.georef.setOrthogonalHeightTooltip': 'Set OrthogonalHeight to sampled terrain height ({value} m)',
  'properties.georef.setOrthogonalHeightTooltipViaSource': 'Set OrthogonalHeight to sampled terrain height ({value} m via {source})',
} as const satisfies Record<string, TranslationValue>;
