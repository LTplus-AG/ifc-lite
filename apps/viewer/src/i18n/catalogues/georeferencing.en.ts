/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/** GeoreferencingPanel and its field rows (#6639). */
export const georeferencingEn = {
  // GeoreferencingPanel: GeorefRow / AngleRow
  'properties.georef.computedTooltip': 'Computed from XAxisAbscissa and XAxisOrdinate',
  'properties.georef.editedBadge': 'edited',
  'properties.georef.editField': 'Edit {field}',
  'properties.georef.saveField': 'Save {field}',
  'properties.georef.cancelField': 'Cancel editing {field}',
  'properties.georef.selectPlaceholder': '-- select --',
  'properties.georef.hint.crsName': 'e.g. EPSG:4326',
  'properties.georef.hint.epsgLookup': 'Use EPSG lookup to search',
  'properties.georef.hint.crsDescription': 'e.g. WGS 84 / UTM zone 32N',
  'properties.georef.hint.geodeticDatum': 'e.g. WGS84',
  'properties.georef.hint.verticalDatum': 'e.g. MSL',
  'properties.georef.hint.mapProjection': 'e.g. Transverse Mercator',
  'properties.georef.hint.mapZone': 'e.g. 32N',
  'properties.georef.hint.zero': '0.0',
  'properties.georef.hint.one': '1.0',
  'properties.georef.hint.eastings': 'X offset in map units',
  'properties.georef.hint.northings': 'Y offset in map units',
  'properties.georef.hint.height': 'Z offset in metres',
  'properties.georef.hint.abscissa': 'East component of the model X-axis direction in map coordinates. The direction vector need not have unit length.',
  'properties.georef.hint.ordinate': 'North component of the model X-axis direction in map coordinates. The direction vector need not have unit length.',
  'properties.georef.hint.scale': 'Converts model units to map units and applies the map scale. Defaults to 1 when omitted.',
  'properties.georef.angleEditTooltip': 'Edit angle to auto-compute XAxisAbscissa/XAxisOrdinate',
  'properties.georef.angleToGridNorth': 'Model rotation in map coordinates',
  'properties.georef.rotationConvention': 'Counterclockwise from map East to model X. Positive values rotate the model counterclockwise on the map.',
  'properties.georef.defaultValue': 'Default: {value}',
  'properties.georef.degUnit': 'deg',
  'properties.georef.angleSetsAxesNote': 'Sets XAxisAbscissa = cos(angle), XAxisOrdinate = sin(angle)',
  // GeoreferencingPanel: main panel
  'properties.georef.noGeoreferencing': 'No georeferencing',
  'properties.georef.addGeoreferencing': 'Add Georeferencing',
  'properties.georef.reloadPrompt': 'Georeference saved. Reload loaded models to recompute 3D alignment?',
  'properties.georef.reloadModels': 'Reload models',
  'properties.georef.reloadMissingSource': 'Cannot reload {name}: source file is not available', 'properties.georef.reloadPartial': 'Reloaded {loaded} of {total} models. Could not reload: {failed}.',
  'properties.georef.reloadSuccess': 'Reloaded models for edited georeferencing', 'properties.georef.reloadFailedWithMessage': 'Reload failed: {message}', 'properties.georef.reloadFailed': 'Reload failed',
  'properties.georef.later': 'Later',
  'properties.georef.legacySiteNotice': 'Showing legacy IfcSite geolocation from IFC2X3. This view is read-only.',
  'properties.georef.unsupportedSchemaNotice': 'Georeferencing editing requires IFC4 or newer. IFC2X3 does not support IfcProjectedCRS or IfcMapConversion.',
  'properties.georef.noProjectedCrs': 'No projected CRS',
  'properties.georef.epsgButton': 'EPSG',
  'properties.georef.doubleGeorefHeading': 'This model is georeferenced twice. ifc-lite corrected it.',
  'properties.georef.doubleGeorefBody':
    'The geometry already sits at map coordinates (E {eastingValue} N {northingValue}), and this IfcMapConversion repeats the same offset. ifc-lite places the geometry where it already is; a tool that applied the conversion on top would put the model {displacement} away.',
  'properties.georef.rotationOverrideNote':
    'This file also authors a map rotation that cannot be reconciled with its own coordinates, so the model is placed grid-aligned. Check the orientation, and set Model rotation in map coordinates by hand if it looks wrong.',
  'properties.georef.distanceUnknown': 'an unknown distance',
  'properties.georef.distancePlanetWidth': 'more than a planet-width',
  'properties.georef.distanceKilometres': 'about {value} km',
  'properties.georef.distanceMetres': 'about {value} m',
  'properties.georef.scaleOverride': {
    one: 'Its {fields} is not applied either.',
    other: 'Its {fields} are not applied either.',
  },
  'properties.georef.scaleOverrideReason': {
    one: 'Its {fields} is not applied either: on map-sized coordinates it would re-scale the model about the map origin.',
    other: 'Its {fields} are not applied either: on map-sized coordinates they would re-scale the model about the map origin.',
  },
  'properties.georef.correctionOffsets': 'set Eastings and Northings to 0',
  'properties.georef.correctionAngle': 'set Model rotation in map coordinates to 0',
  'properties.georef.correctionScale': 'set Scale to {value}',
  'properties.georef.rawValuesCorrection':
    "The file's own values are shown below exactly as authored. The export is worth fixing at source; to bake the correction in here, {edits}, then use Export IFC (with changes).",
  'properties.georef.rawValuesCorrectionFactor': {
    one: "The file's own values are shown below exactly as authored. The export is worth fixing at source; to bake the correction in here, {edits}, then use Export IFC (with changes). {factors} is not editable in ifc-lite; set it to 1 in the authoring tool, or the exported file is still scaled by it.",
    other: "The file's own values are shown below exactly as authored. The export is worth fixing at source; to bake the correction in here, {edits}, then use Export IFC (with changes). {factors} are not editable in ifc-lite; set them to 1 in the authoring tool, or the exported file is still scaled by them.",
  },
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
  'properties.georef.noConversionNotice': 'No coordinate operation. Add map coordinates, model rotation in map coordinates, and scale.',
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
