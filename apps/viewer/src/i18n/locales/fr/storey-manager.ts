/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const storeyManagerFr = {
  "storeyManager.title": "Étages",
  "storeyManager.subtitle": "{model} · {count} étages",
  "storeyManager.open": "Gérer les étages…",
  "storeyManager.back": "Revenir à l’inspecteur",
  "storeyManager.undoLabel": "Modification d’étage",
  "storeyManager.addAbove": "Ajouter un étage au-dessus",
  "storeyManager.addBelow": "Ajouter un étage en dessous",
  "storeyManager.addAboveOf": "Ajouter un étage au-dessus de {storey}",
  "storeyManager.addBelowOf": "Ajouter un étage en dessous de {storey}",
  "storeyManager.fallbackName": "Niveau {index}",
  "storeyManager.added": "{storey} ajouté à {elevation} m",
  "storeyManager.renamed": "Renommé en {storey}",
  "storeyManager.column.name": "Nom",
  "storeyManager.column.elevation": "Altitude",
  "storeyManager.column.height": "Hauteur entre étages",
  "storeyManager.column.elements": "Éléments",
  "storeyManager.elements": {
    "one": "{count} élément",
    "many": "{count} éléments",
    "other": "{count} éléments"
  },
  "storeyManager.active": "Dessin ici",
  "storeyManager.activeGroup": "Étage de dessin",
  "storeyManager.activate": "Dessiner sur {storey}",
  "storeyManager.noStoreyAbove": "Dernier étage : aucun étage supérieur pour mesurer la hauteur",
  "storeyManager.field.name": "Nom de {storey}",
  "storeyManager.field.elevation": "Altitude de {storey}, en mètres",
  "storeyManager.field.height": "Hauteur entre étages de {storey}, en mètres",
  "storeyManager.field.hint": "Entrée applique · Échap annule",
  "storeyManager.invalid.name": "Un étage doit avoir un nom",
  "storeyManager.invalid.length": "Saisissez une longueur, par exemple 3.00, 3,5 ou 3500 mm",
  "storeyManager.invalid.height": "Saisissez une hauteur supérieure à zéro, par exemple 3.00 ou 3500 mm",
  "storeyManager.mode.elevation": "Déplace uniquement {storey} ; les étages supérieurs restent en place",
  "storeyManager.mode.height": "Décale tous les étages au-dessus de {storey} de la même distance",
  "storeyManager.impact.title": "Ce qui change",
  "storeyManager.impact.storeys": {
    "one": "Déplace {count} étage",
    "many": "Déplace {count} étages",
    "other": "Déplace {count} étages"
  },
  "storeyManager.impact.elements": {
    "one": "déplace {count} élément",
    "many": "déplace {count} éléments",
    "other": "déplace {count} éléments"
  },
  "storeyManager.impact.walls": {
    "one": "redimensionne {count} mur",
    "many": "redimensionne {count} murs",
    "other": "redimensionne {count} murs"
  },
  "storeyManager.impact.stairs": {
    "one": "réadapte {count} escalier",
    "many": "réadapte {count} escaliers",
    "other": "réadapte {count} escaliers"
  },
  "storeyManager.impact.held": {
    "one": "maintient en place {count} élément d’un autre étage",
    "many": "maintient en place {count} éléments d’autres étages",
    "other": "maintient en place {count} éléments d’autres étages"
  },
  "storeyManager.impact.nothing": "Aucun déplacement : l’étage est déjà à cette position",
  "storeyManager.impact.preview": "Aperçu en 3D et sur le plan avant application",
  "storeyManager.impact.planOnly": "Dans une salle partagée, l’aperçu n’est pas visible par tous : Entrée applique la modification",
  "storeyManager.notice.wallNotResized": {
    "one": "{count} mur rattaché se déplace mais conserve sa hauteur : ce n’est pas une extrusion simple",
    "many": "{count} murs rattachés se déplacent mais conservent leur hauteur : ce ne sont pas des extrusions simples",
    "other": "{count} murs rattachés se déplacent mais conservent leur hauteur : ce ne sont pas des extrusions simples"
  },
  "storeyManager.notice.wallAttachmentUnresolved": {
    "one": "{count} mur conserve sa hauteur : son rattachement supérieur enregistré ne désigne pas un étage unique",
    "many": "{count} murs conservent leur hauteur : leurs rattachements supérieurs enregistrés ne désignent pas un étage unique",
    "other": "{count} murs conservent leur hauteur : leurs rattachements supérieurs enregistrés ne désignent pas un étage unique"
  },
  "storeyManager.notice.wallQuantitiesPartial": {
    "one": "{count} mur redimensionné possède plusieurs jeux de quantités de base : seul le premier est mis à jour",
    "many": "{count} murs redimensionnés possèdent plusieurs jeux de quantités de base : seul le premier est mis à jour",
    "other": "{count} murs redimensionnés possèdent plusieurs jeux de quantités de base : seul le premier est mis à jour"
  },
  "storeyManager.notice.stairNotRefit": {
    "one": "{count} escalier se déplace sans être réadapté : ce n’est pas une volée unique à marches",
    "many": "{count} escaliers se déplacent sans être réadaptés : ce ne sont pas des volées uniques à marches",
    "other": "{count} escaliers se déplacent sans être réadaptés : ce ne sont pas des volées uniques à marches"
  },
  "storeyManager.notice.select": "Les sélectionner",
  "storeyManager.refusal.spacing": "Il ne reste aucune hauteur entre {storey} et {neighbour}",
  "storeyManager.refusal.crossingAbove": "{storey} dépasserait {neighbour} ({neighbourElevation} m) au-dessus",
  "storeyManager.refusal.crossingBelow": "{storey} passerait sous {neighbour} ({neighbourElevation} m) en dessous",
  "storeyManager.refusal.topStorey": "{storey} est le dernier étage : aucun étage supérieur pour mesurer la hauteur",
  "storeyManager.refusal.shared": {
    "one": "{count} élément partage son placement avec un autre étage et ne peut donc pas être déplacé seul",
    "many": "{count} éléments partagent leur placement avec d’autres étages et ne peuvent donc pas être déplacés seuls",
    "other": "{count} éléments partagent leur placement avec d’autres étages et ne peuvent donc pas être déplacés seuls"
  },
  "storeyManager.refusal.unplaced": {
    "one": "{count} élément possède une géométrie mais aucun placement et ne peut donc pas être déplacé",
    "many": "{count} éléments possèdent une géométrie mais aucun placement et ne peuvent donc pas être déplacés",
    "other": "{count} éléments possèdent une géométrie mais aucun placement et ne peuvent donc pas être déplacés"
  },
  "storeyManager.refusal.unreadable": {
    "one": "Le placement de {count} élément ne peut pas être lu",
    "many": "Le placement de {count} éléments ne peut pas être lu",
    "other": "Le placement de {count} éléments ne peut pas être lu"
  },
  "storeyManager.refusal.onlyStorey": "Un modèle doit conserver au moins un étage",
  "storeyManager.refusal.stale": "Le modèle a changé depuis votre vérification. Vérifiez-le à nouveau avant de confirmer.",
  "storeyManager.refusal.tooLarge": "{storey} contient trop d’éléments pour une modification en une seule opération",
  "storeyManager.refusal.other": "Non appliqué : {reason}",
  "storeyManager.refusal.nothingChanged": "Aucune modification effectuée.",
  "storeyManager.delete": "Supprimer {storey}",
  "storeyManager.deleted": "{storey} supprimé",
  "storeyManager.undo": "Annuler",
  "storeyManager.undoStale": "Suppression non annulée : des modifications ultérieures existent. Annulez-les d’abord depuis la barre d’outils.",
  "storeyManager.delete.title": {
    "one": "{storey} contient {count} élément",
    "many": "{storey} contient {count} éléments",
    "other": "{storey} contient {count} éléments"
  },
  "storeyManager.delete.moveTo": "Les déplacer vers",
  "storeyManager.delete.move": "Déplacer et supprimer",
  "storeyManager.delete.withContents": {
    "one": "Supprimer avec son {count} élément",
    "many": "Supprimer avec ses {count} éléments",
    "other": "Supprimer avec ses {count} éléments"
  },
  "storeyManager.delete.cancel": "Conserver l’étage",
  "storeyManager.strip.label": "Étages à l’échelle",
  "storeyManager.strip.level": "{storey} à {elevation} m",
  "storeyManager.loading": "Lecture des étages…",
  "storeyManager.empty": "Ce modèle ne contient pas encore d’étages",
  "storeyManager.addFirst": "Ajouter un étage à ±0.00",
  "storeyManager.noModel": "Ouvrez un modèle dans l’espace Modèle pour gérer ses étages",
  "storeyManager.readOnly": "Les étages peuvent être consultés mais pas modifiés : {reason}",
  "storeyManager.error": "Impossible de lire les étages : {reason}",
  "storeyManager.drawOn": "Dessiner sur",
  "storeyManager.copy.title": "Copier vers les étages…",
  "storeyManager.copy.empty": "Sélectionnez les éléments à copier",
  "storeyManager.copy.all": "Sélectionner tous les étages",
  "storeyManager.copy.level": "{storey} ({elevation} m)",
  "storeyManager.copy.prepare": "Préparer les copies",
  "storeyManager.copy.commit": "Copier maintenant",
  "storeyManager.copy.cancel": "Annuler",
  "storeyManager.copy.progress": "Préparation de l’étage {progress} sur {count}…",
  "storeyManager.copy.ready": "Prêt à copier {elements} éléments vers {count} étages. Vous pouvez encore annuler.",
  "storeyManager.copy.done": "{count} éléments copiés",
  "storeyManager.copy.stale": "Le modèle a changé. Préparez à nouveau les copies.",
  "storeyManager.wallTarget": "Jusqu’à {storey} ({elevation} m)",
  'storeyManager.copy.from': 'Depuis l’étage',
  'storeyManager.copy.to': 'Jusqu’à l’étage',
  "storeyManager.copy.readOnly": "La copie est indisponible : {reason}",
} satisfies Catalogue;
