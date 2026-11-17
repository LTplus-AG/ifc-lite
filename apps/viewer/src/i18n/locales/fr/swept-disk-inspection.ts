/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const sweptDiskInspectionFr = {
  "properties.sweptDisk.heading": "Géométrie source dérivée",
  "properties.sweptDisk.sourceNote": "Mesures de la directrice dérivées de la source saisie. Les attributs IFC et les valeurs IfcElementQuantity sont listés séparément.",
  "properties.sweptDisk.loading": "Lecture de la géométrie source sélectionnée…",
  "properties.sweptDisk.empty": "Aucune géométrie source à balayage de disque pour cette sélection",
  "properties.sweptDisk.solid": "IfcSweptDiskSolid #{id}",
  "properties.sweptDisk.status": "Description",
  "properties.sweptDisk.complete": "Complète",
  "properties.sweptDisk.unsupported": "Non prise en charge",
  "properties.sweptDisk.sourceModified": "Source modifiée par CSG",
  "properties.sweptDisk.modifiedHint": "La directrice source peut différer du résultat visible.",
  "properties.sweptDisk.modifiedHighlightHint": "Le segment source ne peut pas être mis en surbrillance sur le maillage modifié par CSG.",
  "properties.sweptDisk.yes": "Oui",
  "properties.sweptDisk.no": "Non",
  "properties.sweptDisk.directrix": "Directrice source",
  "properties.sweptDisk.mappingPath": "Chemin mappé",
  "properties.sweptDisk.none": "Aucun",
  "properties.sweptDisk.radius": "Rayon",
  "properties.sweptDisk.innerRadius": "InnerRadius (rayon intérieur)",
  "properties.sweptDisk.unsupportedRadiusHint": "Le rayon est la valeur saisie ; un rayon en coordonnées globales n'a pas pu être établi.",
  "properties.sweptDisk.derivedCentreline": "Mesures dérivées de l'axe",
  "properties.sweptDisk.totalLength": "Longueur totale de l'axe",
  "properties.sweptDisk.segment": "Segment n° {index}",
  "properties.sweptDisk.bend": "Amplitude de la courbure",
  "properties.sweptDisk.signedSweep": "Balayage signé",
} satisfies Catalogue;
