/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const miscPanelsBFr = {
  'federationSetupControls.saved': 'Configuration de fédération enregistrée.',
  'federationSetupControls.invalid': 'Fichier de configuration de fédération non valide : {reason}',
  'federationSetupControls.pickSources': 'Configuration chargée avec {count} emplacements de modèle — choisissez maintenant les fichiers source correspondants.',
  'federationSetupControls.result.restored': '{restored}/{total} modèles restaurés',
  'federationSetupControls.result.missing': 'fichiers source manquants : {names}',
  'federationSetupControls.result.mismatched': 'même nom, contenu différent : {names}',
  'federationSetupControls.result.anchorMissing': 'l’ancrage d’alignement n’a pas pu être restauré',
  'federationSetupControls.result.tagsMissing': 'étiquettes non restaurées pour les sources manquantes : {names}',
  'federationSetupControls.result.failed': 'fichiers source trouvés mais non chargés : {slots}',
  'federationSetupControls.result.failedSlot': '{name} ({reason})',
  // ---- PointCloudPanel.tsx
  'pointCloudPanel.title': 'Nuage de points',
  'pointCloudPanel.close': 'Fermer le panneau du nuage de points',
  'pointCloudPanel.assetCount': { one: '{count} ressource', many: '{count} de ressources', other: '{count} ressources' },
  'pointCloudPanel.colourSectionLabel': 'Couleur',
  'pointCloudPanel.colorMode.rgb.label': 'RVB',
  'pointCloudPanel.colorMode.rgb.hint': 'Couleur par point issue de la source',
  'pointCloudPanel.colorMode.classification.label': 'Classification',
  'pointCloudPanel.colorMode.classification.hint':
    'Palette des classes ASPRS (sol, végétation, bâtiment…)',
  'pointCloudPanel.colorMode.intensity.label': 'Intensité',
  'pointCloudPanel.colorMode.intensity.hint': 'Dégradé de gris selon l’intensité de chaque point',
  'pointCloudPanel.colorMode.height.label': 'Hauteur',
  'pointCloudPanel.colorMode.height.hint': 'Dégradé froid-chaud selon la hauteur dans le monde (Y vers le haut)',
  'pointCloudPanel.colorMode.fixed.label': 'Unie',
  'pointCloudPanel.colorMode.fixed.hint': 'Remplacement par une couleur unique',
  'pointCloudPanel.colorMode.deviation.label': 'Écart',
  'pointCloudPanel.colorMode.deviation.hint':
    'Distance signée à la surface BIM la plus proche (calcul ci-dessous)',
  'pointCloudPanel.deviation.computeHint':
    'Lancez « Calculer l’écart » ci-dessous pour remplir la carte thermique.',
  'pointCloudPanel.deviation.needsModelHint': 'Chargez un modèle BIM auquel comparer le scan.',
  'pointCloudPanel.solidColourLabel': 'Couleur unie',
  'pointCloudPanel.solidColourPickerAriaLabel': 'Choisir la couleur unie appliquée en mode fixe',
  'pointCloudPanel.alignToModel.hint':
    'Applique l’IfcMapConversion inverse afin que les coordonnées cartographiques absolues du scan (eastings/northings/hauteur) s’alignent sur le modèle IFC. Désactivez pour voir le scan dans ses coordonnées brutes, non transformées.',
  'pointCloudPanel.alignToModel.label': 'Aligner sur le géoréférencement du modèle',
  'pointCloudPanel.alignToModel.checkboxTitle': 'Aligner sur le géoréférencement du modèle (IfcMapConversion)',
  'pointCloudPanel.sizeSectionLabel': 'Taille',
  'pointCloudPanel.sizeMode.fixedPx.label': 'Fixe',
  'pointCloudPanel.sizeMode.fixedPx.hint': 'Toujours rendre à la valeur du curseur (en pixels)',
  'pointCloudPanel.sizeMode.attenuated.label': 'Auto',
  'pointCloudPanel.sizeMode.attenuated.hint':
    'Adaptatif (plus proche = plus grand), plafonné à la valeur du curseur',
  'pointCloudPanel.sizeMode.adaptiveWorld.label': 'Monde',
  'pointCloudPanel.sizeMode.adaptiveWorld.hint':
    'Rayon purement dans l’espace du monde — chaque point couvre N mm dans l’espace source',
  'pointCloudPanel.pointSizePx': '{value} px',
  'pointCloudPanel.splatSizeTitle': 'Taille des points en pixels (ou plafond en mode Auto)',
  'pointCloudPanel.worldRadiusMm': '{value} mm',
  'pointCloudPanel.worldRadiusTitle': 'Rayon des points dans l’espace du monde, en millimètres',
  'pointCloudPanel.edlSectionLabel': 'Ombrage des contours',
  'pointCloudPanel.edlCheckboxTitle':
    'L’ombrage des contours (EDL, Eye-Dome Lighting) ajoute une perception de la profondeur aux nuages de points.',
  'pointCloudPanel.edlStrengthTitle': 'Intensité de l’ombrage des contours (EDL)',
  // ---- PointCloudClasses.tsx
  'pointCloudClasses.summaryLabel': 'Classes',
  'pointCloudClasses.visibleCount': '{visible} visibles sur {total}',
  'pointCloudClasses.emptyState': 'Aucune donnée de classification dans les scans chargés.',
  'pointCloudClasses.showAll': 'Tout afficher',
  'pointCloudClasses.toggleAriaLabel': 'Afficher/masquer {label} (classe {classId})',
  // ---- PointCloudLegend.tsx
  'pointCloudLegend.intensityLabel': 'Intensité',
  'pointCloudLegend.intensityRampAriaLabel':
    'Dégradé d’intensité de faible (noir) à élevée (blanc)',
  'pointCloudLegend.low': 'faible',
  'pointCloudLegend.high': 'élevée',
  'pointCloudLegend.heightLabel': 'Hauteur (Y vers le haut)',
  'pointCloudLegend.heightRampAriaLabel': 'Dégradé de hauteur de basse (bleu) à haute (rouge)',
  // ---- ModelTagRuleEditor.tsx
  'modelTagRuleEditor.pickTagsAriaLabel': 'Choisir des étiquettes de modèle',
  'modelTagRuleEditor.pickTagsPlaceholder': 'Choisir des étiquettes…',
  'modelTagRuleEditor.selectedCount': '{count} sélectionnée(s)',
  'modelTagRuleEditor.noTagsYet': 'Aucune étiquette de modèle pour l’instant — étiquetez d’abord un modèle dans la hiérarchie.',
  'modelTagRuleEditor.unresolvedWarning': {
    one: '{count} étiquette de cette règle n’existe plus — la règle ne correspond à rien tant qu’elle n’est pas corrigée.',
    many: '{count} d’étiquettes de cette règle n’existent plus — la règle ne correspond à rien tant qu’elle n’est pas corrigée.',
    other: '{count} étiquettes de cette règle n’existent plus — la règle ne correspond à rien tant qu’elle n’est pas corrigée.',
  },
  // ---- FederationSetupControls.tsx
  'federationSetupControls.reopenTitle': 'Rouvrir une configuration de fédération',
  'federationSetupControls.reopenDescription':
    'Vérifiez la correspondance entre chaque emplacement de modèle enregistré et vos fichiers locaux avant de restaurer.',
  'federationSetupControls.cancel': 'Annuler',
  'federationSetupControls.restoringButton': 'Restauration…',
  'federationSetupControls.restoreButton': 'Restaurer la fédération',
  'federationSetupControls.confidence.content': 'Correspondant',
  'federationSetupControls.confidence.nameSize': 'Correspondant (par nom)',
  'federationSetupControls.confidence.nameOnly': 'Même nom, fichier différent',
  'federationSetupControls.confidence.none': 'Manquant',
  // ---- ShareDialog.tsx
  'shareDialog.titleMulti': 'Partager {count} modèles',
  'shareDialog.titleSingle': 'Partager « {model} »',
  'shareDialog.description': 'Toute personne disposant du lien peut rejoindre la session — aucun compte n’est nécessaire.',
  'shareDialog.loadModelFirst': 'Chargez d’abord un modèle, puis partagez-le.',
  'shareDialog.anyoneCanLabel': 'Toute personne disposant du lien peut',
  'shareDialog.accessLevelAriaLabel': 'Niveau d’accès',
  'shareDialog.role.viewer.label': 'Consulter',
  'shareDialog.role.viewer.hint': 'Voir le modèle, les curseurs et les commentaires',
  'shareDialog.role.commenter.label': 'Commenter',
  'shareDialog.role.commenter.hint': 'Ajouter aussi des problèmes et des annotations',
  'shareDialog.role.editor.label': 'Modifier',
  'shareDialog.role.editor.hint': 'Modifier aussi les propriétés et la géométrie',
  'shareDialog.linkLabel': 'Lien',
  'shareDialog.copied': 'Copié',
  'shareDialog.copy': 'Copier',
  'shareDialog.copyFailed': 'Impossible de copier le lien. Sélectionnez-le dans le champ et copiez-le manuellement.',
  'shareDialog.liveNow': 'En direct',
  'shareDialog.linkExpiryNotice': 'Le lien expire dans 7 jours. Toute personne qui le possède obtient l’accès « {role} ».',
  'shareDialog.youSuffix': '{name} (vous)',
  'shareDialog.guestName': 'Invité',
  'shareDialog.roomCreationFailed':
    'Aucune session n’a été créée. Fermez puis rouvrez cette boîte de dialogue pour réessayer.',
  'shareDialog.linkCreationFailed': 'Échec de la création du lien. Vérifiez la connexion et réessayez.',
  'shareDialog.joinedViaInvite':
    'Vous avez rejoint la session via une invitation ; la partager transmet le même accès. Seul l’administrateur de la session peut créer de nouveaux liens.',
  'shareDialog.onlyAdminCanCreate': 'Seul l’administrateur de la session peut créer des liens d’invitation pour cette session.',
  'shareDialog.mintFailedReusing':
    'Impossible de créer un nouveau lien ; votre invitation actuelle est réutilisée (même accès).',
  'shareDialog.linkField.awaitingScope': 'Choisissez ce que vous partagez, puis créez le lien',
  'shareDialog.linkField.awaitingConsent': 'Créez le lien pour partager ce modèle',
  'shareDialog.linkField.seedInFlight': 'Le lien sera prêt une fois le téléversement terminé…',
  'shareDialog.linkField.creatingRoom': 'Création de la session…',
  'shareDialog.linkField.generating': 'Génération du lien…',
  // ---- ShareScopeField.tsx
  'shareScopeField.allPartial': 'Les {seedable} modèles partageables sur {loaded} chargés',
  'shareScopeField.allFull': 'Les {loaded} modèles chargés',
  'shareScopeField.roomCarries': {
    one: 'Cette session contient {count} modèle.',
    many: 'Cette session contient {count} de modèles.',
    other: 'Cette session contient {count} modèles.',
  },
  'shareScopeField.partialCanBeShared':
    '{seedable} des {loaded} modèles chargés peuvent être partagés, chacun comme modèle distinct ; un GLB, un nuage de points ou un modèle encore en cours de chargement n’a rien à placer dans une session.',
  'shareScopeField.allShared':
    'Chaque modèle chargé est partagé comme modèle distinct ; les destinataires voient donc tout l’espace de travail.',
  'shareScopeField.onlyActiveShared':
    'Seul « {model} » est partagé ; les autres modèles chargés restent privés.',
  'shareScopeField.shareLabel': 'Partager',
  'shareScopeField.scopeAriaLabel': 'Portée du partage',
  'shareScopeField.activeOnly': 'Modèle actif uniquement',
  'shareScopeField.createLink': 'Créer le lien',
  'shareScopeField.uploadNotice':
    'La création du lien téléverse les données du modèle partagé vers le serveur de collaboration, afin que les personnes disposant du lien puissent l’ouvrir.',
  // ---- LoadReportPanel.tsx
  'loadReportPanel.selectAndFrameTitle': 'Sélectionner et cadrer cette entité',
  'loadReportPanel.entitySummary':
    '#{productId} {ifcType} — {csgFailures} échec(s), {openings} ouverture(s)',
  'loadReportPanel.tierSuffix': ' · niveau {tier}',
  'loadReportPanel.fastModeSuffix': ' · mode rapide',
  'loadReportPanel.affectedEntitiesLabel': 'Entités concernées',
  'loadReportPanel.title': 'Rapport de chargement',
  'loadReportPanel.exportJsonTitle': 'Exporter en JSON',
  'loadReportPanel.closeTitle': 'Fermer',
  'loadReportPanel.noModelsLoaded': 'Aucun modèle chargé.',
  'loadReportPanel.status.unavailable': 'Diagnostics indisponibles',
  'loadReportPanel.status.clean': 'Sans problème',
  'loadReportPanel.status.issuesFound': 'Problèmes détectés',
  'loadReportPanel.omittedTypeRecords': {
    one: '« {name} » : {count} définition de type n’a pas pu être lue ; sa géométrie de type a donc été omise.',
    many: '« {name} » : {count} de définitions de type n’ont pas pu être lues ; leur géométrie de type a donc été omise.',
    other: '« {name} » : {count} définitions de type n’ont pas pu être lues ; leur géométrie de type a donc été omise.',
  },
  // ---- GeometryModeBanner.tsx
  'geometryModeBanner.detailPinRemoved': 'Épingle de détail supprimée',
  'geometryModeBanner.fastEnabled': 'Géométrie rapide activée',
  'geometryModeBanner.exactEnabled': 'Géométrie exacte activée',
  'geometryModeBanner.reloadHint': 'Rechargez le modèle pour appliquer le nouveau paramètre.',
  'geometryModeBanner.reloadButton': 'Recharger',
  'geometryModeBanner.dismissAriaLabel': 'Ignorer le rappel de rechargement',
  // ---- FilterRuleControls.tsx
  'filterRuleControls.combinatorTitle': 'ET exige que chaque règle corresponde. OU correspond à n’importe quelle règle.',
  'filterRuleControls.filterDimensionLabel': 'Dimension du filtre',
  'filterRuleControls.addRuleDefaultLabel': 'Ajouter une règle',
  // ---- GeometryAxisRow.tsx
  'geometryAxisRow.decreaseAriaLabel': 'Diminuer {label}',
  'geometryAxisRow.increaseAriaLabel': 'Augmenter {label}',
  // ---- EntityContextMenu.tsx
  'entityContextMenu.entityActions': 'Actions sur l’entité',
  'entityContextMenu.canvasActions': 'Actions sur le canevas',
  'entityContextMenu.duplicateDefaultTitle': 'Dupliquer d’une largeur de boîte englobante selon +X (par défaut)',
  'entityContextMenu.duplicateLabel': 'Dupliquer',
  'entityContextMenu.duplicateDirectionLabel': 'Dupliquer dans la direction',
  'entityContextMenu.frameSelection': 'Cadrer la sélection',
  'entityContextMenu.hide': 'Masquer',
  'entityContextMenu.setBasket': 'Définir la collection',
  'entityContextMenu.addToBasket': 'Ajouter à la collection',
  'entityContextMenu.removeFromBasket': 'Retirer de la collection',
  'entityContextMenu.saveBasketView': 'Enregistrer la vue de la collection',
  'entityContextMenu.selectAllType': 'Sélectionner tous les {type}',
  'entityContextMenu.selectSameStorey': 'Sélectionner le même étage',
  'entityContextMenu.exportAnonymized': 'Exporter anonymisé…',
  'entityContextMenu.deleteEntity': 'Supprimer l’entité',
  'entityContextMenu.duplicateXPlus': 'Dupliquer +X (est)',
  'entityContextMenu.duplicateXMinus': 'Dupliquer −X (ouest)',
  'entityContextMenu.duplicateYPlus': 'Dupliquer +Y (nord)',
  'entityContextMenu.duplicateYMinus': 'Dupliquer −Y (sud)',
  'entityContextMenu.duplicateZPlus': 'Dupliquer +Z (haut)',
  'entityContextMenu.duplicateZMinus': 'Dupliquer −Z (bas)',
  // ---- TextAnnotationEditor.tsx
  'textAnnotationEditor.placeholder': 'Saisissez le texte de l’annotation…',
  'textAnnotationEditor.inputLabel': 'Texte de l’annotation',
  'textAnnotationEditor.hint': 'Entrée pour valider · Maj+Entrée pour un saut de ligne · Échap pour annuler',
  // ---- presence/PeerPresenceLayer.tsx
  'peerPresenceLayer.cursorsAriaLabel': 'Curseurs des collaborateurs',
  'peerPresenceLayer.guestName': 'Invité',
  'peerPresenceLayer.nameWithTool': '{name} — {tool}',
  // ---- BottomStrip.tsx / BottomStripHeader.tsx
  'bottomStrip.gripTitle': 'Faites glisser pour détacher · faites glisser sur un autre écran pour ouvrir une fenêtre séparée',
  'bottomStrip.tabListAriaLabel': 'Panneaux inférieurs ouverts',
  'bottomStrip.closeTabAriaLabel': 'Fermer {name}',
  'bottomStrip.maximize': 'Agrandir',
  'bottomStrip.restore': 'Restaurer',
  'bottomStrip.close': 'Fermer',
  'bottomStrip.dockBeside': 'Ancrer à côté de la vue 3D',
  'bottomStrip.dockBelow': 'Ancrer sous la vue 3D',
  // ---- SaveMarkupToModelButton.tsx
  'saveMarkupToModelButton.menuItemLabel': 'Enregistrer les annotations dans le modèle',
  // ---- ExportChangesButton.tsx
  'exportChangesButton.buttonLabel': 'Exporter l’IFC modifié…',
  'exportChangesButton.tooltipMulti': 'Exporter l’IFC modifié… pour {models} modèles ({count} modifications)',
  'exportChangesButton.tooltipSingle': {
    one: 'Exporter l’IFC modifié… avec {count} modification appliquée',
    many: 'Exporter l’IFC modifié… avec {count} de modifications appliquées',
    other: 'Exporter l’IFC modifié… avec {count} modifications appliquées',
  },
  // ---- SearchableSelect.tsx
  'searchableSelect.defaultPlaceholder': 'Sélectionner…',
  'searchableSelect.searchPlaceholder': 'Rechercher…',
  'searchableSelect.filterOptionsLabel': 'Filtrer les options',
  'searchableSelect.noMatches': 'Aucune correspondance',
} satisfies Catalogue;
