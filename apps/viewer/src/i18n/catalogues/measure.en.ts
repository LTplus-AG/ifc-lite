/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * The Measure tool (#2199 et al.) — its HUD bar (`MeasureToolbar.tsx`), the
 * hint and geo readout (`MeasureHudReadouts.tsx`), the Measurements side
 * panel (`MeasurementsPanel.tsx`) with its three tabs (`MeasurementList.tsx`,
 * `MeasureQuantities.tsx`, `MeasurePointReadout.tsx`), the on-canvas overlay
 * labels (`MeasurementVisuals.tsx`), and the shared georeferenced E/N/H
 * readout (`measure-modes/geo-readout.tsx`). Measurement unit symbols (`m`, `m²`,
 * `mm`, `°`) are not catalogued — those stay literal by the sweep's own
 * rule (#4918).
 */
export const measureEn = {
  'measure.panelTitle': 'Measure',
  'measure.bar.modeAria': 'Measure mode',
  'measure.bar.angleKindAria': 'Angle kind',
  // MeasurementsPanel.tsx — the docked side panel (#5502).
  'measure.panel.title': 'Measurements',
  'measure.panel.toggleTitle': 'Show or hide the Measurements panel',
  'measure.panel.close': 'Close panel',
  'measure.panel.startMeasuring': 'Start measuring',
  'measure.clearAll': 'Clear all',
  'measure.clearAllConfirm': 'Clear every measurement? This cannot be undone.',
  'measure.close': 'Close',

  // Angle-mode click hints (`angleHint`), one key per kind/pick-count
  // combination — see MeasurePanel.tsx's own doc comment on why a single
  // "n/3 picks" wording doesn't fit every kind.
  'measure.hint.faces.first': 'Click the first face',
  'measure.hint.faces.second': 'Click the second face · Esc to cancel',
  'measure.hint.edges.firstStart': 'Click the start of the first edge',
  'measure.hint.edges.firstEnd': 'Click the end of the first edge · Esc to cancel',
  'measure.hint.edges.secondStart': 'Click the start of the second edge · Esc to cancel',
  'measure.hint.edges.secondEnd': 'Click the end of the second edge · Esc to cancel',
  'measure.hint.points.apex': 'Click the apex of the angle',
  'measure.hint.points.first': 'Click the first direction · Esc to cancel',
  'measure.hint.points.second': 'Click the second direction · Esc to cancel',

  // ANGLE_KIND_LABELS — button text + tooltip for each of the three angle kinds.
  'measure.angleKind.points.label': '3-Point',
  'measure.angleKind.points.hint':
    'Angle at an apex: click the corner first, then the two directions',
  'measure.angleKind.edges.label': 'Edges',
  'measure.angleKind.edges.hint':
    'Angle between two lines: click two points on the first, then two on the second. Four clicks, because snap metadata yields tessellation segments rather than whole edges',
  'measure.angleKind.faces.label': 'Faces',
  'measure.angleKind.faces.hint': 'Angle between two planes: click one face, then the other',

  // TABS — the List / Point / Qty tabs of the Measurements panel (the bar's
  // panel button reuses the List label).
  'measure.section.list.label': 'List',
  'measure.section.list.title': 'Measurements taken',
  'measure.section.point.label': 'Point',
  'measure.section.point.title': 'Coordinates of the picked point',
  'measure.section.quantities.label': 'Qty',
  'measure.section.quantities.title': 'Quantities of the selected elements',

  'measure.mode.distance': 'Distance',
  'measure.mode.polyline': 'Polyline',
  'measure.mode.angle': 'Angle',
  'measure.mode.radius': 'Radius',

  'measure.snapToggle.title': 'Toggle snap (S key)',
  'measure.snap.label': 'Snap',

  'measure.geoToggle.enabledTitle': 'Toggle real-world XYZ (Eastings / Northings / Height)',
  'measure.geoToggle.disabledTitle': 'Requires map georeferencing (IfcMapConversion) in the model',
  'measure.geo.label': 'Geo XYZ',
  'measure.geo.easting': 'E',
  'measure.geo.northing': 'N',
  'measure.geo.height': 'H',
  // Bare "m" as a JSX text node (not a `hint="m"` prop, which the sweep's own
  // scanner does not flag) trips the literal scanner despite the sweep's
  // unit-symbol exception — keyed to satisfy the gate mechanically.
  'measure.geo.unitMeters': 'm',

  'measure.list.empty': 'No measurements',
  'measure.list.totalCurrent': 'Total (current)',
  'measure.list.deleteDistance': 'Delete distance measurement {index}',
  'measure.list.deletePolyline': 'Delete polyline measurement {index}',
  'measure.list.deleteAngle': 'Delete angle measurement {index}',
  'measure.list.deleteRadius': 'Delete radius measurement {index}',
  'measure.polyline.inProgress': {
    one: 'Polyline in progress — {count} pt',
    other: 'Polyline in progress — {count} pts',
  },
  'measure.cancelEsc': 'Cancel (Esc)',
  'measure.polyline.indexLabel': 'Poly #{index}',
  'measure.polyline.basisLength': 'Length',
  'measure.polyline.basisPerimeterClosed': 'Perimeter (closed)',
  'measure.angle.indexLabel': 'Angle #{index}',
  'measure.angle.inProgress': 'Angle in progress · {picks}/{required} picks',
  'measure.angle.apexSetSuffix': ' · apex set',
  'measure.angle.firstEdgeSetSuffix': ' · first edge set',
  'measure.radius.indexLabel': 'Radius #{index}',
  'measure.radius.inProgress': {
    one: 'Radius in progress · {count} pick',
    other: 'Radius in progress · {count} picks',
  },

  'measure.hint.polylineActive':
    'Click to add point · dbl-click/Enter to finish · click start to close · Esc to cancel',
  'measure.hint.polylineStart': 'Click to start polyline',
  'measure.hint.radiusActive':
    'Click to add a point on the arc · dbl-click/Enter to finish · Esc to cancel',
  'measure.hint.radiusStart': 'Click 3+ points on a circular edge',
  'measure.hint.dragActive': 'Release to complete',
  'measure.hint.dragStart': 'Drag to measure',

  'measure.readout.live': 'Live',
  'measure.readout.last': 'Last',
  'measure.readout.latLon': 'Lat {lat} / Lon {lon}',

  // MeasurePointReadout.tsx
  'measure.point.emptyPrompt': 'Measure a point to read its coordinates',
  'measure.point.setReferenceTitle': 'Set this point as the relative-coordinate reference',
  'measure.point.clearReferenceTitle': 'Clear the reference point',
  'measure.point.live': 'Live point',
  'measure.point.last': 'Last point',
  'measure.point.rowAnchor': 'Anchor',
  'measure.point.rowModel': 'Model',
  'measure.point.rowRender': 'Render',
  'measure.point.rowDatum': 'Datum',
  'measure.point.rowRelative': 'Relative',
  'measure.point.rowMap': 'Map',
  'measure.point.rowLatLon': 'Lat / Lon',
  'measure.point.rebasedNote':
    "Federation alignment re-based one or more models into {name}'s frame, so these are anchor coordinates, not necessarily the picked file's own.",
  'measure.point.anchorModelFallback': 'the anchor model',

  // MeasureQuantities.tsx
  'measure.qty.length': 'Length',
  'measure.qty.area': 'Area',
  'measure.qty.volume': 'Volume',
  'measure.qty.weight': 'Weight',
  'measure.basis.net': 'net',
  'measure.basis.gross': 'gross',
  'measure.weight.massDerived': 'Mass derived',
  'measure.weight.massEstimated': 'Mass estimated',
  'measure.weight.massDerivedTitle':
    'Mass CALCULATED as the meshed geometry volume (after opening cuts) x the material density the file declares in Pset_MaterialCommon.MassDensity. Not an IFC-declared weight quantity. A mass, not a force.',
  'measure.weight.massEstimatedTitle':
    'Mass ESTIMATED as the meshed geometry volume (after opening cuts) x a density from the project density library. The file does not declare this density. A mass, not a force.',
  'measure.quantities.selectPrompt': 'Select elements to read their quantities',
  'measure.quantities.header': 'Quantities',
  'measure.quantities.elementsCount': {
    one: '{count} element',
    other: '{count} elements',
  },
  'measure.quantities.nothingFound':
    'The selection declares no quantities, no enclosed volume could be proved from its geometry, and no triangulated mesh area could be measured either.',
  'measure.quantities.volumeMeshLabel': 'Volume mesh',
  'measure.quantities.volumeMeshTitle':
    'Enclosed volume computed from the meshed geometry, after opening cuts. Not an IFC GrossVolume.',
  'measure.quantities.areaMeshLabel': 'Area mesh',
  'measure.quantities.areaMeshTitle':
    'Total triangulated surface of the meshed geometry — every face, not one side. Not an IFC NetSideArea/GrossSideArea.',
  'measure.quantities.legend':
    'net = openings excluded · gross = openings included · mesh = as built, after opening cuts (volume) or total triangulated surface (area)',
  'measure.quantities.massLegend':
    "mass derived = mesh volume × the file's Pset_MaterialCommon.MassDensity. Not an IFC-declared weight quantity.",
  'measure.quantities.massLegendWithEstimated':
    "mass derived = mesh volume × the file's Pset_MaterialCommon.MassDensity; mass estimated = mesh volume × a project library density the file does not declare. Not an IFC-declared weight quantity.",
  'measure.quantities.densityAmbiguous': {
    one:
      '{count} element declares materials with different densities and no share of the volume to apportion between them, so no mass was derived for it.',
    other:
      '{count} elements declare materials with different densities and no share of the volume to apportion between them, so no mass was derived for them.',
  },
  'measure.quantities.weightUnitIsForce': {
    one:
      '{count} element sits in a model whose MASSUNIT declares a force, not a mass. No mass was derived rather than guessing whether the result should read as kilograms or kilonewtons.',
    other:
      '{count} elements sit in a model whose MASSUNIT declares a force, not a mass. No mass was derived rather than guessing whether the result should read as kilograms or kilonewtons.',
  },
  'measure.quantities.unprovedVolume': {
    one: '{count} element had no provable enclosed volume (open shell, layered or multi-part geometry).',
    other: '{count} elements had no provable enclosed volume (open shell, layered or multi-part geometry).',
  },
  'measure.quantities.noMeshToMeasure': {
    one: '{count} element had no triangulated mesh to measure (e.g. instanced-only geometry).',
    other: '{count} elements had no triangulated mesh to measure (e.g. instanced-only geometry).',
  },
  'measure.quantities.meshAreaIncomplete': {
    one:
      '{count} element included in the mesh area total has a submesh with invalid vertex data; its contribution is a partial sum, not a complete measurement.',
    other:
      '{count} elements included in the mesh area total have a submesh with invalid vertex data; their contribution is a partial sum, not a complete measurement.',
  },
  'measure.quantities.rescaledVolume': {
    one:
      '{count} element sits in a model federation alignment rescaled; its proved volume no longer describes the geometry on screen and is withheld.',
    other:
      '{count} elements sit in a model federation alignment rescaled; their proved volume no longer describes the geometry on screen and is withheld.',
  },
  'measure.quantities.unresolvedElements': {
    one: '{count} selected element could not be resolved to a loaded model.',
    other: '{count} selected elements could not be resolved to a loaded model.',
  },

  // MeasurementVisuals.tsx — in-progress polyline overlay label.
  'measure.visuals.polylineSoFar': '{basis} so far - {count} pts',
} as const satisfies Record<string, TranslationValue>;
