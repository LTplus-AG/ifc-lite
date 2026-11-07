/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const clashToolsFr = {
  // ClashExportActions.tsx
  'clashTools.export.noResultsToast': 'Aucun résultat de collision à exporter',
  'clashTools.export.csvSuccessToast': {
    one: '{count} collision exportée vers {filename}',
    many: '{count} de collisions exportées vers {filename}',
    other: '{count} collisions exportées vers {filename}',
  },
  'clashTools.export.bcfTopicTooltipSelected': 'Créer un sujet BCF à partir de la collision sélectionnée',
  'clashTools.export.bcfTopicTooltipAll': 'Créer un sujet BCF pour ce rapport de collisions',
  'clashTools.export.bcfTopicButton': 'Sujet BCF',
  'clashTools.bcfTopic.created': 'Sujet créé',
  'clashTools.bcfTopic.open': 'Ouvrir BCF',
  'clashTools.export.formatBcf': 'BCF',
  'clashTools.export.formatCsv': 'CSV',
  'clashTools.export.bcfArchiveTooltip': 'Exporter les collisions sous forme d’archive BCF pour un autre outil BCF',
  'clashTools.export.bcfArchiveMenu': 'Archive BCF…',
  'clashTools.export.csvMenu': 'Tableau CSV',
  'clashTools.export.csvTooltip':
    'Télécharger chaque collision de cette exécution sous forme de tableau CSV — une ligne par collision avec les deux GlobalId, le statut de vérification et l’étage — pour Excel / Power BI',
  // ClashModelTagNotice.tsx
  'clashTools.modelTagNotice.message':
    'Les étiquettes de modèle ont changé depuis cette exécution. Ses ensembles ont été résolus à partir des étiquettes de l’époque ; relancez-la pour utiliser les étiquettes actuelles.',
  // ClashBcfExportDialog.tsx
  'clashTools.bcfExport.dialogTitle': 'Exporter en BCF',
  'clashTools.bcfExport.dialogDescription':
    'Transformez les collisions en un ensemble gérable de sujets BCF. Choisissez leur regroupement, celles à inclure et l’intégration éventuelle d’instantanés.',
  'clashTools.bcfExport.groupByLabel': 'Regrouper en sujets par',
  'clashTools.bcfExport.groupCluster': 'Groupe spatial',
  'clashTools.bcfExport.groupClusterHint':
    'Les collisions voisines de même nature sont fusionnées en un seul sujet — le choix par défaut raisonnable.',
  'clashTools.bcfExport.groupRule': 'Règle de discipline',
  'clashTools.bcfExport.groupRuleHint': 'Un sujet par règle (MEP × Structure, CVC × Architecture, …).',
  'clashTools.bcfExport.groupTypePair': 'Paire de types d’éléments',
  'clashTools.bcfExport.groupTypePairHint': 'Un sujet par paire de types (IfcDuct × IfcWall, …).',
  'clashTools.bcfExport.groupElement': 'Élément concerné',
  'clashTools.bcfExport.groupElementHint': 'Un sujet par élément — toutes les collisions d’un élément au même endroit.',
  'clashTools.bcfExport.severitiesLabel': 'Gravités à inclure',
  'clashTools.bcfExport.clashesLabel': 'collisions',
  'clashTools.bcfExport.topicsLabel': { one: 'sujet', other: 'sujets' },
  'clashTools.bcfExport.maxTopicsLabel': 'Nombre max. de sujets',
  'clashTools.bcfExport.topicStatusNote':
    'Le statut du sujet suit le statut de vérification de chaque collision : Ouverte reste Open, Résolue et Acceptée sont exportées comme Closed.',
  'clashTools.bcfExport.includeSnapshotsLabel': 'Inclure des instantanés',
  'clashTools.bcfExport.snapshotsHint':
    'Rendre le point de vue de chaque sujet et intégrer un PNG. Plus lent avec de nombreux sujets.',
  'clashTools.bcfExport.capturingSnapshotsProgress': 'Capture des instantanés {done}/{total}…',
  'clashTools.bcfExport.cancelButton': 'Annuler',
  'clashTools.bcfExport.exportingLabel': 'Export en cours…',
  'clashTools.bcfExport.exportButton': { one: 'Exporter {count} sujet', many: 'Exporter {count} de sujets', other: 'Exporter {count} sujets' },
  'clashTools.bcfExport.exportSuccessToast': { one: '{count} sujet BCF exporté', many: '{count} de sujets BCF exportés', other: '{count} sujets BCF exportés' },
  'clashTools.bcfExport.exportFailedToast': 'Échec de l’export BCF : {reason}',
  // ClashSavedReportsDialog.tsx
  'clashTools.savedReports.triggerTooltip': 'Rapports de collisions enregistrés',
  'clashTools.savedReports.dialogDescription':
    'Enregistrez le résultat actuel sous un nom. Un graphique pourra ensuite continuer à l’afficher, quelle que soit la vérification suivante.',
  'clashTools.savedReports.nameLabel': 'Nom du rapport',
  'clashTools.savedReports.saveButton': 'Enregistrer le résultat actuel',
  'clashTools.savedReports.currentSummary': 'Résultat actuel : {clashes}.',
  'clashTools.savedReports.currentLimits': 'Il sera enregistré ainsi : {limits}.',
  'clashTools.savedReports.savedToast': 'Rapport de collisions « {name} » enregistré.',
  'clashTools.savedReports.storageFailed': 'Le rapport de collisions n’a pas pu être enregistré dans ce navigateur.',
  'clashTools.savedReports.empty': 'Aucun rapport de collisions enregistré pour l’instant.',
  'clashTools.savedReports.entrySummary': '{clashes} · enregistré {when} · {models}',
  'clashTools.savedReports.renameLabel': 'Nom de « {name} »',
  'clashTools.savedReports.renameButton': 'Renommer',
  'clashTools.savedReports.deleteButton': 'Supprimer',
  'clashTools.savedReports.deleteWarning': 'Les graphiques qui lisent « {name} » l’afficheront comme indisponible.',
  'clashTools.savedReports.confirmDeleteButton': 'Supprimer le rapport',
  'clashTools.savedReports.cancelDeleteButton': 'Conserver',
  'clashTools.revisionCompare.triggerTooltip': 'Comparer les exécutions de collisions entre révisions',
  'clashTools.revisionCompare.originalFinding': 'Constat d’origine de la référence enregistrée',
  'clashTools.revisionCompare.dialogTitle': 'Comparer les exécutions de collisions',
  'clashTools.revisionCompare.dialogDescription':
    'Enregistrez le résultat actuel comme référence, puis comparez-le à une exécution ultérieure — collisions nouvelles, persistantes et qui ne sont plus détectées.',
  'clashTools.revisionCompare.baselineSavedAt': 'Référence enregistrée {when}',
  'clashTools.revisionCompare.clashCount': { one: '{count} collision', many: '{count} de collisions', other: '{count} collisions' },
  'clashTools.revisionCompare.baselineSavedToast': {
    one: 'Référence enregistrée ({count} collision).',
    many: 'Référence enregistrée ({count} de collisions).',
    other: 'Référence enregistrée ({count} collisions).',
  },
  'clashTools.revisionCompare.noBaseline': 'Aucune référence enregistrée pour l’instant.',
  'clashTools.revisionCompare.saveBaselineTooltip': 'Enregistrer le résultat actuel comme référence',
  'clashTools.revisionCompare.runDetectionFirstTooltip': 'Lancez d’abord la détection des collisions',
  'clashTools.revisionCompare.saveBaselineButton': 'Enregistrer l’actuel comme référence',
  'clashTools.revisionCompare.saveBaselineFirstTooltip': 'Enregistrez d’abord une référence',
  'clashTools.revisionCompare.compareButton': 'Comparer le résultat actuel à la référence',
  'clashTools.revisionCompare.unretestedCount': {
    one: '{count} collision n’a pas pu être confirmée comme corrigée :',
    many: '{count} de collisions n’ont pas pu être confirmées comme corrigées :',
    other: '{count} collisions n’ont pas pu être confirmées comme corrigées :',
  },
  'clashTools.revisionCompare.newBucketTitle': 'Nouvelles',
  'clashTools.revisionCompare.persistingBucketTitle': 'Persistantes',
  'clashTools.revisionCompare.resolvedBucketTitle': 'Plus détectées',
  'clashTools.revisionCompare.unretestedBucketTitle': 'Non confirmées (non retestées)',
  'clashTools.revisionCompare.noDifferences': 'Aucune différence.',
  'clashTools.revisionCompare.skippedRules': 'Non réexécutées cette fois : {ids}.',
  'clashTools.revisionCompare.noMatchRules': 'Aucun élément correspondant lors de cette exécution : {ids}.',
  'clashTools.revisionCompare.missingModels': 'Modèle(s) ne faisant plus partie de la comparaison : {names}.',
  'clashTools.revisionCompare.unretestedGeneric':
    'Un ou plusieurs éléments dont dépendait une collision n’ont pas été retenus par la même règle lors de cette exécution (sélecteur restreint ou changement d’appartenance) — elle ne peut plus être confirmée comme corrigée.',
  // ClashRuleDraftEditor.tsx
  'clashTools.ruleEditor.editTitle': 'Modifier la règle',
  'clashTools.ruleEditor.newTitle': 'Nouvelle règle',
  'clashTools.ruleEditor.cancelTooltip': 'Annuler',
  'clashTools.ruleEditor.namePlaceholder': 'Nom de la règle (p. ex. Gaines contre poutres)',
  'clashTools.ruleEditor.nameLabel': 'Nom de la règle',
  'clashTools.ruleEditor.selectorAPlaceholder': 'IfcDuct*|IfcPipe*',
  'clashTools.ruleEditor.selectorALabel': 'Sélecteur de type IFC de l’ensemble A',
  'clashTools.ruleEditor.selectorBPlaceholder': 'IfcWall*|IfcSlab',
  'clashTools.ruleEditor.selectorBLabel': 'Sélecteur de type IFC de l’ensemble B',
  'clashTools.ruleEditor.saveButton': 'Enregistrer',
  'clashTools.ruleEditor.addButton': 'Ajouter',
  'clashTools.ruleEditor.selectorsIntro': 'Sélecteurs :',
  'clashTools.ruleEditor.selectorExamplePipe': 'IfcPipe*',
  'clashTools.ruleEditor.selectorExampleWallSlab': 'IfcWall|IfcSlab',
  'clashTools.ruleEditor.selectorExampleNotSpace': '!IfcSpace',
  'clashTools.ruleEditor.selectorsHelp':
    'Laissez B identique à A pour une auto-collision au sein d’un même groupe. Donnez plutôt des règles de filtre à un côté pour le sélectionner par propriété, attribut, étage ou quantité — son sélecteur devient alors inutile et peut rester vide.',
  'clashTools.ruleEditor.loadModelHint': 'chargez un modèle pour l’aperçu',
  'clashTools.ruleEditor.matchCount': { one: '✓ correspond à {count} classe', many: '✓ correspond à {count} de classes', other: '✓ correspond à {count} classes' },
  'clashTools.ruleEditor.noMatches': 'ne correspond à aucune classe',
  // ClashSetFilterEditor.tsx
  'clashTools.setFilter.clearTooltip': 'Supprimer toutes les règles et revenir au sélecteur de type',
  'clashTools.setFilter.clearLabel': 'Effacer',
  'clashTools.setFilter.unreadableWarning': {
    one:
      '{count} entrée de ce filtre ne peut pas être lue par cette version (enregistrée par une version plus récente, ou mal formée). Les exécutions qui l’utilisent sont refusées ; toute modification ici supprime cette entrée.',
    many:
      '{count} d’entrées de ce filtre ne peuvent pas être lues par cette version (enregistrées par une version plus récente, ou mal formées). Les exécutions qui l’utilisent sont refusées ; toute modification ici supprime ces entrées.',
    other:
      '{count} entrées de ce filtre ne peuvent pas être lues par cette version (enregistrées par une version plus récente, ou mal formées). Les exécutions qui l’utilisent sont refusées ; toute modification ici supprime ces entrées.',
  },
  'clashTools.setFilter.definedByFilter':
    'Ce filtre définit {label} ; le sélecteur de type ci-dessus est ignoré tant que le filtre contient des règles.',
  // ClashSettingsDialog.tsx
  'clashTools.settings.title': 'Paramètres des collisions',
  'clashTools.settings.summary': 'Réglez la détection et organisez le jeu de règles. {enabled} règles activées sur {total}.',
  'clashTools.settings.detectionTab': 'Détection',
  'clashTools.settings.rulesTab': 'Règles',
  'clashTools.settings.modeLabel': 'Mode par défaut',
  'clashTools.settings.modeHint':
    'Le mode dur détecte les interpénétrations ; le mode dégagement détecte les écarts inférieurs à la distance requise.',
  'clashTools.settings.toleranceLabel': 'Tolérance',
  'clashTools.settings.toleranceHint':
    'Bande de contact (m). Les surfaces à cette distance ou moins comptent comme un contact, non comme une pénétration.',
  'clashTools.settings.clearanceGapLabel': 'Écart de dégagement',
  'clashTools.settings.clearanceGapHint':
    'Écart requis (m) en mode dégagement. Tout ce qui est plus proche constitue une violation.',
  'clashTools.settings.duplicateToleranceLabel': 'Tolérance des doublons',
  'clashTools.settings.duplicateToleranceHint':
    'Distance maximale (m) entre deux éléments pour qu’ils comptent encore comme le même objet lors de la recherche de doublons. Plafonnée par l’épaisseur propre de chaque élément : une plaque de 2 mm obtient 2 mm dans son épaisseur, et non la valeur complète.',
  'clashTools.settings.clusterRadiusLabel': 'Rayon de regroupement',
  'clashTools.settings.clusterRadiusHint':
    'Distance maximale entre des collisions pour qu’elles soient encore fusionnées en un seul sujet BCF (m).',
  'clashTools.settings.reportTouchLabel': 'Signaler les contacts rasants',
  'clashTools.settings.reportTouchHint':
    'Inclure dans la détection les résultats classés comme contacts (surfaces qui ne font que se frôler).',
  'clashTools.settings.showRegionBoxLabel': 'Afficher la boîte de la zone de collision',
  'clashTools.settings.showRegionBoxHint':
    'Dessiner une boîte filaire ajustée autour de la zone de contact de la collision active pour marquer la pénétration. Activé par défaut ; désactivez-le pour la masquer.',
  'clashTools.settings.groupingLabel': 'Regroupement par défaut',
  'clashTools.settings.groupingHint': 'Organisation de la liste des résultats dans le panneau.',
  'clashTools.settings.modeHard': 'Dur',
  'clashTools.settings.modeClearance': 'Dégagement',
  'clashTools.settings.groupBySeverity': 'Par gravité',
  'clashTools.settings.groupByRule': 'Par règle',
  'clashTools.settings.groupByTypePair': 'Par paire de types',
  'clashTools.settings.resetDetectionButton': 'Réinitialiser les paramètres de détection',
  'clashTools.settings.addRuleButton': 'Ajouter une règle',
  'clashTools.settings.resetRulesTooltip': 'Rétablir les règles intégrées',
  'clashTools.settings.exportRulesTooltip': 'Exporter les règles',
  'clashTools.settings.importRulesTooltip': 'Importer les règles',
  'clashTools.settings.customBadge': 'personnalisée',
  'clashTools.settings.editTooltip': 'Modifier',
  'clashTools.settings.deleteTooltip': 'Supprimer',
  'clashTools.settings.noValidRulesToast': 'Aucune règle valide trouvée dans ce fichier.',
  'clashTools.settings.importedRulesToast': { one: '{count} règle importée', many: '{count} de règles importées', other: '{count} règles importées' },
  'clashTools.settings.importReadErrorToast': 'Impossible de lire ce fichier comme règles de collision.',
} satisfies Catalogue;
