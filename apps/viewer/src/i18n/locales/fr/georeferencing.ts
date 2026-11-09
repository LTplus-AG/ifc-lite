/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const georeferencingFr = {
  // GeoreferencingPanel: GeorefRow / AngleRow
  'properties.georef.computedTooltip': 'Calculé à partir de XAxisAbscissa et XAxisOrdinate',
  'properties.georef.editedBadge': 'modifié',
  'properties.georef.editField': 'Modifier {field}',
  'properties.georef.saveField': 'Enregistrer {field}',
  'properties.georef.cancelField': 'Annuler la modification de {field}',
  'properties.georef.selectPlaceholder': '-- sélectionner --',
  'properties.georef.hint.crsName': 'p. ex. EPSG:4326',
  'properties.georef.hint.epsgLookup': 'Utilisez la recherche EPSG',
  'properties.georef.hint.crsDescription': 'p. ex. WGS 84 / UTM zone 32N',
  'properties.georef.hint.geodeticDatum': 'p. ex. WGS84',
  'properties.georef.hint.verticalDatum': 'p. ex. MSL',
  'properties.georef.hint.mapProjection': 'p. ex. Mercator transverse',
  'properties.georef.hint.mapZone': 'p. ex. 32N',
  'properties.georef.hint.zero': '0,0',
  'properties.georef.hint.one': '1,0',
  'properties.georef.hint.eastings': 'Décalage X en unités cartographiques',
  'properties.georef.hint.northings': 'Décalage Y en unités cartographiques',
  'properties.georef.hint.height': 'Décalage Z en mètres',
  'properties.georef.hint.abscissa': 'Composante est de la direction de l’axe X du modèle en coordonnées cartographiques. Le vecteur de direction n’a pas besoin d’être unitaire.',
  'properties.georef.hint.ordinate': 'Composante nord de la direction de l’axe X du modèle en coordonnées cartographiques. Le vecteur de direction n’a pas besoin d’être unitaire.',
  'properties.georef.hint.scale': 'Convertit les unités du modèle en unités cartographiques et applique l’échelle de la carte. Vaut 1 par défaut lorsqu’elle est omise.',
  'properties.georef.angleEditTooltip': 'Modifier l’angle pour calculer automatiquement XAxisAbscissa/XAxisOrdinate',
  'properties.georef.angleToGridNorth': 'Rotation du modèle en coordonnées cartographiques',
  'properties.georef.rotationConvention': 'Sens antihoraire depuis l’est de la carte jusqu’à l’axe X du modèle. Les valeurs positives font pivoter le modèle dans le sens antihoraire sur la carte.',
  'properties.georef.defaultValue': 'Par défaut : {value}',
  'properties.georef.degUnit': '°',
  'properties.georef.angleSetsAxesNote': 'Définit XAxisAbscissa = cos(angle), XAxisOrdinate = sin(angle)',
  // GeoreferencingPanel: main panel
  'properties.georef.noGeoreferencing': 'Aucun géoréférencement',
  'properties.georef.addGeoreferencing': 'Ajouter un géoréférencement',
  'properties.georef.reloadPrompt': 'Géoréférencement enregistré. Recharger les modèles chargés pour recalculer l’alignement 3D ?',
  'properties.georef.reloadModels': 'Recharger les modèles',
  'properties.georef.reloadMissingSource': 'Impossible de recharger {name} : le fichier source n’est pas disponible',
  'properties.georef.reloadPartial': '{loaded} modèles rechargés sur {total}. Rechargement impossible : {failed}.',
  'properties.georef.reloadSuccess': 'Modèles rechargés pour le géoréférencement modifié',
  'properties.georef.reloadFailedWithMessage': 'Échec du rechargement : {message}',
  'properties.georef.reloadFailed': 'Échec du rechargement',
  'properties.georef.later': 'Plus tard',
  'properties.georef.legacySiteNotice': 'Affichage de l’ancienne géolocalisation IfcSite d’IFC2X3. Cette vue est en lecture seule.',
  'properties.georef.unsupportedSchemaNotice': 'La modification du géoréférencement nécessite IFC4 ou une version plus récente. IFC2X3 ne prend pas en charge IfcProjectedCRS ni IfcMapConversion.',
  'properties.georef.showFullWellKnownText': 'Afficher la définition WKT complète',
  'properties.georef.coordinateOperationReadOnlyNotice': 'Géoréférencé par une IfcRigidOperation IFC4X3 ou une définition de SRC IfcWellKnownText. Cette vue est en lecture seule.',
  'properties.georef.noProjectedCrs': 'Aucun SRC projeté',
  'properties.georef.epsgButton': 'EPSG',
  'properties.georef.doubleGeorefHeading': 'Ce modèle est géoréférencé deux fois. ifc-lite l’a corrigé.',
  'properties.georef.doubleGeorefBody':
    'La géométrie se trouve déjà aux coordonnées cartographiques (E {eastingValue} N {northingValue}), et cette IfcMapConversion répète le même décalage. ifc-lite place la géométrie là où elle se trouve déjà ; un outil qui appliquerait la conversion en plus placerait le modèle à {displacement}.',
  'properties.georef.rotationOverrideNote':
    'Ce fichier définit également une rotation cartographique incompatible avec ses propres coordonnées ; le modèle est donc placé aligné sur la grille. Vérifiez l’orientation et réglez manuellement la rotation du modèle en coordonnées cartographiques si elle semble incorrecte.',
  'properties.georef.distanceUnknown': 'une distance inconnue',
  'properties.georef.distancePlanetWidth': 'plus que la largeur d’une planète',
  'properties.georef.distanceKilometres': 'environ {value} km',
  'properties.georef.distanceMetres': 'environ {value} m',
  'properties.georef.scaleOverride': {
    one: 'Son attribut {fields} n’est pas non plus appliqué.',
    other: 'Ses attributs {fields} ne sont pas non plus appliqués.',
  },
  'properties.georef.scaleOverrideReason': {
    one: 'Son attribut {fields} n’est pas non plus appliqué : sur des coordonnées à l’échelle de la carte, il remettrait le modèle à l’échelle autour de l’origine de la carte.',
    other: 'Ses attributs {fields} ne sont pas non plus appliqués : sur des coordonnées à l’échelle de la carte, ils remettraient le modèle à l’échelle autour de l’origine de la carte.',
  },
  'properties.georef.correctionOffsets': 'réglez Eastings et Northings sur 0',
  'properties.georef.correctionAngle': 'réglez la rotation du modèle en coordonnées cartographiques sur 0',
  'properties.georef.correctionScale': 'réglez Scale sur {value}',
  'properties.georef.rawValuesCorrection':
    'Les valeurs propres au fichier sont affichées ci-dessous exactement telles qu’elles ont été saisies. Il vaut la peine de corriger l’export à la source ; pour intégrer la correction ici, {edits}, puis utilisez Exporter en IFC (avec les modifications).',
  'properties.georef.rawValuesCorrectionFactor': {
    one: 'Les valeurs propres au fichier sont affichées ci-dessous exactement telles qu’elles ont été saisies. Il vaut la peine de corriger l’export à la source ; pour intégrer la correction ici, {edits}, puis utilisez Exporter en IFC (avec les modifications). {factors} n’est pas modifiable dans ifc-lite ; réglez-le sur 1 dans l’outil de création, sinon le fichier exporté reste mis à l’échelle par ce facteur.',
    other: 'Les valeurs propres au fichier sont affichées ci-dessous exactement telles qu’elles ont été saisies. Il vaut la peine de corriger l’export à la source ; pour intégrer la correction ici, {edits}, puis utilisez Exporter en IFC (avec les modifications). {factors} ne sont pas modifiables dans ifc-lite ; réglez-les sur 1 dans l’outil de création, sinon le fichier exporté reste mis à l’échelle par ces facteurs.',
  },
  'properties.georef.projectedCrsHeading': 'SRC projeté',
  'properties.georef.missingCrsNotice': 'Une opération de coordonnées existe, mais le SRC projeté est manquant.',
  'properties.georef.addCrs': 'Ajouter un SRC',
  'properties.georef.coordinateOperationHeading': 'Opération de coordonnées',
  'properties.georef.scaleInconsistentAriaLabel': 'Échelle incohérente avec les unités du projet/de la carte',
  'properties.georef.scaleInconsistentTooltip': 'Échelle incohérente avec les unités du projet/de la carte — développez pour voir les détails',
  'properties.georef.eastingNorthingSummary': 'E {easting} N {northing}',
  'properties.georef.scaleAttributeInconsistent': '{attribute} incohérent avec les unités du projet/de la carte.',
  'properties.georef.scaleCompensatedNote':
    'Selon le schéma IFC, IfcMapConversion.Scale (multiplié par le facteur IfcMapConversionScaled sur chaque axe) doit compenser la différence entre l’unité de longueur du projet et l’unité du SRC cartographique. Valeur actuelle de {attribute} = {authoredValue} ; valeur attendue ≈ {expectedValue}.',
  'properties.georef.scaleCompensatedDetail':
    'ifc-lite compense et place la géométrie à 1× — aucune action n’est nécessaire ici, mais un outil qui suit strictement le schéma affichera ce fichier à {specEffectiveScale}× sa taille physique.',
  'properties.georef.scaleUncompensatedDetail':
    'La géométrie est placée à {effectiveScale}× sa taille physique — ajustez {fixAttribute} pour corriger.',
  'properties.georef.scaleFixAttributeScale': 'Scale (ou MapUnit)',
  'properties.georef.noConversionNotice': 'Aucune opération de coordonnées. Ajoutez les coordonnées cartographiques, la rotation du modèle en coordonnées cartographiques et l’échelle.',
  'properties.georef.addCoordinates': 'Ajouter des coordonnées',
  'properties.georef.visibleSurfaceHeight': 'Hauteur de la surface visible',
  'properties.georef.heightMeters': '{value} m',
  'properties.georef.queryingEllipsis': 'interrogation…',
  'properties.georef.sampledVia': 'échantillonnée via {source}',
  'properties.georef.setOrthogonalHeightButton': 'Régler OrthogonalHeight sur la hauteur du terrain échantillonnée ({value} m)',
  'properties.georef.heightsEllipsoidalLabel': 'Les hauteurs sont ellipsoïdales (ignorer la correction du géoïde)',
  'properties.georef.heightsEllipsoidalHelp':
    'Désactivé par défaut : OrthogonalHeight est traitée comme une altitude orthométrique et l’ondulation du géoïde est ajoutée pour que le modèle ne soit pas enfoui sous le terrain.',
  'properties.georef.globePlacement.label': 'Placement sur le globe',
  'properties.georef.globePlacement.auto': 'Automatique',
  'properties.georef.globePlacement.anchor': 'Ancrage',
  'properties.georef.globePlacement.exact': 'Exact',
  'properties.georef.globePlacement.resolvedAnchor': 'Placé à l’aide d’un seul point d’ancrage.',
  'properties.georef.globePlacement.resolvedExact': 'Chaque sommet est placé via la projection cartographique.',
  'properties.georef.globePlacement.estimate': 'Erreur d’ancrage estimée : {value} cm',
  'properties.georef.globePlacement.resolvedRigid':
    'IfcRigidOperation : les coordonnées sont des coordonnées cartographiques ; chaque sommet est donc placé via la projection cartographique.',
  'properties.georef.globePlacement.rigidAnchorWarning':
    'Ce fichier utilise une IfcRigidOperation, dont les coordonnées sont des coordonnées cartographiques. L’ancrage ne fait que les approximer ; Automatique ou Exact place chaque sommet.',
  'properties.georef.globePlacement.help':
    'Automatique place chaque sommet pour une IfcRigidOperation, et pour une IfcMapConversion dès qu’un seul point d’ancrage s’écarterait de plus de 1 cm (courbure de la Terre, échelle de projection, pente du géoïde).',
  'properties.georef.setOrthogonalHeightTooltip': 'Régler OrthogonalHeight sur la hauteur du terrain échantillonnée ({value} m)',
  'properties.georef.setOrthogonalHeightTooltipViaSource': 'Régler OrthogonalHeight sur la hauteur du terrain échantillonnée ({value} m via {source})',
} satisfies Catalogue;
