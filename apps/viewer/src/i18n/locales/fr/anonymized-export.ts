/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const anonymizedExportFr = {
  // AnonymizationOptionsPanel
  'anonymizedExport.options.heading': 'Anonymisation',
  'anonymizedExport.options.keepLabel': 'Conserver',
  'anonymizedExport.options.anonymizeLabel': 'Anonymiser',
  'anonymizedExport.options.toggleAriaLabel': 'Anonymiser {label}',
  'anonymizedExport.options.keptAsAuthored': 'conservé tel que créé',
  'anonymizedExport.options.namesLabel': 'Noms',
  'anonymizedExport.options.namesEffect': 'Name/LongName/Description/Tag deviennent IfcType-n',
  'anonymizedExport.options.otherNamesLabel': 'Autres noms',
  'anonymizedExport.options.otherNamesEffect': 'ObjectType, styles, matériaux, calques, profils',
  'anonymizedExport.options.globalIdsLabel': 'GUID',
  'anonymizedExport.options.globalIdsEffect': 'GlobalId régénérés',
  'anonymizedExport.options.propertySetsLabel': 'Jeux de propriétés',
  'anonymizedExport.options.propertySetsEffect': 'Jeux de propriétés et de quantités supprimés',
  'anonymizedExport.options.rootPlacementLabel': 'Position du placement racine',
  'anonymizedExport.options.rootPlacementEffect': 'Translation racine mise à zéro ; rotation conservée',
  'anonymizedExport.options.georeferencingLabel': 'Géoréférencement et adresses',
  'anonymizedExport.options.georeferencingEffect': 'Conversion cartographique, SRC, lat./long. et adresses supprimées',
  'anonymizedExport.options.currencyLabel': 'Devise',
  'anonymizedExport.options.currencyEffect': 'IfcMonetaryUnit devient USD',

  // RelationTogglePanel
  'anonymizedExport.relations.heading': 'Étendre aux éléments liés',
  'anonymizedExport.relations.connectedAriaLabel': 'Éléments connectés',
  'anonymizedExport.relations.connectedDepthLabel': 'Connectés, profondeur',
  'anonymizedExport.relations.openingsLabel': 'Ouvertures',
  'anonymizedExport.relations.fillingsLabel': 'Remplissages et hôte',
  'anonymizedExport.relations.aggregatesLabel': 'Agrégations et imbrications (parents/enfants)',
  'anonymizedExport.relations.typeObjectsLabel': 'Objets types',
  'anonymizedExport.relations.materialsLabel': 'Matériaux',
  'anonymizedExport.relations.propertySetsSourceLabel': 'Jeux de propriétés (source)',

  // RelatedEntityList
  'anonymizedExport.relatedList.seedsLabel': 'Points de départ',
  'anonymizedExport.relatedList.groupLabel': '{relationship} ({role})',
  'anonymizedExport.relatedList.entityFallbackType': 'Entité',
  'anonymizedExport.relatedList.toggleAllAriaLabel': 'Basculer tout : {label}',
  'anonymizedExport.relatedList.lockedBadge': 'verrouillé',
  'anonymizedExport.relatedList.emptyState': 'Aucune entité à exporter pour l’instant.',

  // TypeCategoryBar
  'anonymizedExport.typeCategoryBar.heading': 'Catégories dans l’export',
  'anonymizedExport.typeCategoryBar.clickToBlockHint': 'cliquez sur une catégorie pour l’exclure',
  'anonymizedExport.typeCategoryBar.blockedClickToBlockHint': '{count} exclue(s) · cliquez sur une catégorie pour l’exclure',
  'anonymizedExport.typeCategoryBar.unblockAriaLabel': 'Réinclure {typeName}',
  'anonymizedExport.typeCategoryBar.blockAriaLabel': 'Exclure {typeName}',
  'anonymizedExport.typeCategoryBar.alwaysIncludedTitle': 'Toujours incluse (sélection ou chaîne spatiale)',
  'anonymizedExport.typeCategoryBar.blockedTitle': 'Exclue — cliquez pour l’inclure',
  'anonymizedExport.typeCategoryBar.includedTitle': 'Incluse — cliquez pour l’exclure',

  // AnonymizedExportDialog
  'anonymizedExport.dialog.title': 'Exporter un sous-ensemble anonymisé',
  "anonymizedExport.dialog.description": "Les objets mis en évidence dans la vue 3D à droite sont exportés. Seules les catégories sélectionnées pour l’anonymisation sont anonymisées ; les catégories réglées sur Conserver gardent leurs valeurs d’origine. Les transformations locales sont conservées.",
  'anonymizedExport.dialog.otherModelSeedsExcluded': {
    one: '{count} objet sélectionné dans d’autres modèles n’est pas inclus',
    many: '{count} d’objets sélectionnés dans d’autres modèles ne sont pas inclus',
    other: '{count} objets sélectionnés dans d’autres modèles ne sont pas inclus',
  },
  'anonymizedExport.dialog.droppedOverlaySeedsExcluded': {
    one: '{count} objet sélectionné créé dans cette session n’a pas d’enregistrement source et ne peut pas être inclus',
    many: '{count} d’objets sélectionnés créés dans cette session n’ont pas d’enregistrement source et ne peuvent pas être inclus',
    other: '{count} objets sélectionnés créés dans cette session n’ont pas d’enregistrement source et ne peuvent pas être inclus',
  },
  'anonymizedExport.dialog.noSelectionPrompt': 'Sélectionnez un ou plusieurs objets dans la vue 3D, puis rouvrez cette boîte de dialogue.',
  'anonymizedExport.dialog.resultCount': {
    one: 'Résultat : {count} entité',
    many: 'Résultat : {count} d’entités',
    other: 'Résultat : {count} entités',
  },
  'anonymizedExport.dialog.truncatedBadge': 'Tronqué',
  'anonymizedExport.dialog.previewIn3dLabel': 'Aperçu en 3D',
  'anonymizedExport.dialog.exportingStatus': 'Export en cours…',
  'anonymizedExport.dialog.successTitle': 'Réussite',
  'anonymizedExport.dialog.errorTitle': 'Erreur',
  'anonymizedExport.dialog.fileNameLabel': 'Nom du fichier',
  'anonymizedExport.dialog.ifcExtensionSuffix': '.ifc',
  'anonymizedExport.dialog.cancelButton': 'Annuler',
  'anonymizedExport.dialog.exportingButton': 'Export en cours…',
  'anonymizedExport.dialog.exportButtonLabel': 'Exporter en .ifc',
  'anonymizedExport.dialog.previewCaption': {
    one: 'Aperçu 3D — {count} objet mis en évidence sera exporté',
    many: 'Aperçu 3D — {count} d’objets mis en évidence seront exportés',
    other: 'Aperçu 3D — {count} objets mis en évidence seront exportés',
  },
  'anonymizedExport.dialog.modelDataUnavailableError': 'Les données du modèle ne sont pas disponibles pour l’export',
  'anonymizedExport.dialog.exportedEntities': {
    one: '{count} entité exportée',
    many: '{count} d’entités exportées',
    other: '{count} entités exportées',
  },
  'anonymizedExport.dialog.exportedEntitiesWithWarnings': {
    one: '{count} entité exportée ({warnings} avertissements)',
    many: '{count} d’entités exportées ({warnings} avertissements)',
    other: '{count} entités exportées ({warnings} avertissements)',
  },
  'anonymizedExport.dialog.exportFailedMessage': 'Échec de l’export : {message}',
  'anonymizedExport.dialog.unknownError': 'Erreur inconnue',
} satisfies Catalogue;
