/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const rhinoExportDe = {
  'rhinoExport.triggerButton': 'Rhino (.3dm) exportieren',
  'rhinoExport.dialogTitle': 'Rhino (.3dm) exportieren',
  'rhinoExport.dialogDescription':
    'Schreibt das Modell als Rhino-Netze auf Ebenen, mit den IFC-Eigenschaften als Attribut-Benutzertext.',
  'rhinoExport.modelLabel': 'Modell',
  'rhinoExport.selectModelPlaceholder': 'Modell wählen',
  'rhinoExport.unitsLabel': 'Einheiten',
  'rhinoExport.units.source': 'Einheit der Quelle',
  'rhinoExport.units.meters': 'Meter',
  'rhinoExport.units.millimeters': 'Millimeter',
  'rhinoExport.units.centimeters': 'Zentimeter',
  'rhinoExport.units.feet': 'Fuß',
  'rhinoExport.units.inches': 'Zoll',
  'rhinoExport.layerSchemeLabel': 'Ebenen',
  'rhinoExport.layerScheme.spatial-class': 'Geschoss, dann Klasse',
  'rhinoExport.layerScheme.class': 'Klasse',
  'rhinoExport.layerScheme.presentation': 'Darstellungsebene',
  'rhinoExport.propertiesLabel': 'Eigenschaften',
  'rhinoExport.properties.all': 'Attribute, Eigenschaftssätze und Mengen',
  'rhinoExport.properties.attributes': 'Nur Attribute',
  'rhinoExport.properties.none': 'Keine',
  'rhinoExport.coordinatesLabel': 'Koordinaten',
  'rhinoExport.coordinates.local': 'Lokal (nahe am Ursprung verschoben)',
  'rhinoExport.coordinates.world': 'Welt (wie in der IFC-Datei)',
  'rhinoExport.coordinatesHint':
    'Für Modelle weit vom Ursprung Lokal beibehalten; die Verschiebung steht im Dokument-Benutzertext und im Erdanker.',
  'rhinoExport.versionLabel': '3dm-Version',
  'rhinoExport.version.8': 'Rhino 8',
  'rhinoExport.version.7': 'Rhino 7',
  'rhinoExport.instancingLabel': 'Blöcke',
  'rhinoExport.instancingHint': 'Wiederholte Geometrie einmal als Blockdefinition mit Instanzen schreiben.',
  'rhinoExport.includeSpacesLabel': 'Räume einschließen',
  'rhinoExport.includeSpacesHint': 'IfcSpace-Objekte kommen auf eine ausgeblendete Ebene.',
  'rhinoExport.visibleOnlyLabel': 'Nur sichtbare Elemente',
  'rhinoExport.visibleOnlyHint': 'Lässt weg, was im Viewer ausgeblendet oder durch Isolieren verborgen ist.',
  'rhinoExport.progress.scene': 'Szene wird aufgebaut...',
  'rhinoExport.progress.objects': 'Objekte werden geschrieben: {done} von {total}',
  'rhinoExport.progress.serialize': '.3dm-Datei wird gespeichert...',
  'rhinoExport.stopButton': 'Stopp',
  'rhinoExport.noSourceTitle': 'Keine Quelle verfügbar',
  'rhinoExport.noSourceDescription':
    'Der Rhino-Export braucht die ursprüngliche .ifc- oder .ifczip-Datei. Öffnen Sie das Modell erneut vom Datenträger.',
  'rhinoExport.successTitle': 'Erfolg',
  'rhinoExport.errorTitle': 'Fehler',
  'rhinoExport.exportedMessage': 'Rhino .3dm exportiert ({sizeKb} KB)',
  'rhinoExport.cancelledMessage': 'Rhino-Export gestoppt',
  'rhinoExport.noRenderGeometryError':
    'Der Rhino-Export hat nichts zu schreiben: Das Modell hat keine Render-Geometrie, oder die Sichtbarkeitsfilter haben alles entfernt.',
  'rhinoExport.failedMessage': 'Rhino-Export fehlgeschlagen: {reason}',
  'rhinoExport.cancelButton': 'Abbrechen',
  'rhinoExport.exportingButton': 'Wird exportiert...',
  'rhinoExport.exportButton': 'Exportieren',
} satisfies Catalogue;
