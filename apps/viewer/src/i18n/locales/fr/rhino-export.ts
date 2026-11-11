/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const rhinoExportFr = {
  'rhinoExport.triggerButton': 'Exporter en Rhino (.3dm)',
  'rhinoExport.dialogTitle': 'Exporter en Rhino (.3dm)',
  'rhinoExport.dialogDescription':
    'Écrit le modèle sous forme de maillages Rhino répartis sur des calques, avec les propriétés IFC en texte utilisateur d’attribut.',
  'rhinoExport.modelLabel': 'Modèle',
  'rhinoExport.selectModelPlaceholder': 'Choisir un modèle',
  'rhinoExport.unitsLabel': 'Unités',
  'rhinoExport.units.source': 'Unité de la source',
  'rhinoExport.units.meters': 'Mètres',
  'rhinoExport.units.millimeters': 'Millimètres',
  'rhinoExport.units.centimeters': 'Centimètres',
  'rhinoExport.units.feet': 'Pieds',
  'rhinoExport.units.inches': 'Pouces',
  'rhinoExport.layerSchemeLabel': 'Calques',
  'rhinoExport.layerScheme.spatial-class': 'Étage, puis classe',
  'rhinoExport.layerScheme.class': 'Classe',
  'rhinoExport.layerScheme.presentation': 'Calque de présentation',
  'rhinoExport.propertiesLabel': 'Propriétés',
  'rhinoExport.properties.all': 'Attributs, jeux de propriétés et quantités',
  'rhinoExport.properties.attributes': 'Attributs seulement',
  'rhinoExport.properties.none': 'Aucune',
  'rhinoExport.coordinatesLabel': 'Coordonnées',
  'rhinoExport.coordinates.local': 'Locales (décalées près de l’origine)',
  'rhinoExport.coordinates.world': 'Monde (comme dans le fichier IFC)',
  'rhinoExport.coordinatesHint':
    'Gardez Locales pour les modèles éloignés de l’origine ; le décalage est noté dans le texte utilisateur du document et l’ancrage terrestre.',
  'rhinoExport.versionLabel': 'Version 3dm',
  'rhinoExport.version.8': 'Rhino 8',
  'rhinoExport.version.7': 'Rhino 7',
  'rhinoExport.instancingLabel': 'Blocs',
  'rhinoExport.instancingHint': 'Écrire une seule fois la géométrie répétée, comme définition de bloc avec des instances.',
  'rhinoExport.includeSpacesLabel': 'Inclure les espaces',
  'rhinoExport.includeSpacesHint': 'Les objets IfcSpace vont sur un calque masqué.',
  'rhinoExport.visibleOnlyLabel': 'Éléments visibles seulement',
  'rhinoExport.visibleOnlyHint': 'Laisse de côté ce qui est masqué ou exclu par l’isolation dans la visionneuse.',
  'rhinoExport.progress.scene': 'Construction de la scène...',
  'rhinoExport.progress.objects': 'Écriture des objets : {done} sur {total}',
  'rhinoExport.progress.serialize': 'Enregistrement du fichier .3dm...',
  'rhinoExport.stopButton': 'Arrêter',
  'rhinoExport.noSourceTitle': 'Aucune source disponible',
  'rhinoExport.noSourceDescription':
    'L’export Rhino a besoin du fichier .ifc ou .ifczip d’origine. Rouvrez le modèle depuis le disque pour l’activer.',
  'rhinoExport.successTitle': 'Réussite',
  'rhinoExport.errorTitle': 'Erreur',
  'rhinoExport.exportedMessage': 'Rhino .3dm exporté ({sizeKb} Ko)',
  'rhinoExport.cancelledMessage': 'Export Rhino arrêté',
  'rhinoExport.noRenderGeometryError':
    'L’export Rhino n’a rien à écrire : le modèle n’a pas de géométrie de rendu, ou les filtres de visibilité l’ont entièrement retirée.',
  'rhinoExport.failedMessage': 'Échec de l’export Rhino : {reason}',
  'rhinoExport.cancelButton': 'Annuler',
  'rhinoExport.exportingButton': 'Export en cours...',
  'rhinoExport.exportButton': 'Exporter',
} satisfies Catalogue;
