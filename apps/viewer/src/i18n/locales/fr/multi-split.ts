/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const multiSplitFr = {
  "multiSplit.label": "Découper par une ligne",
  "multiSplit.tool": "Découper par une ligne",
  "commands.model.splitMulti": "Tout découper le long d’une ligne (espace Modèle)",
  "multiSplit.hintStart": "Cliquez sur le premier point de la ligne de coupe · la sélection ou l’étage sera découpé le long de cette ligne · Échap pour quitter",
  "multiSplit.hintEnd": "Cliquez sur le second point ou appuyez sur Entrée pour découper les éléments traversés · Retour arrière recommence la ligne · Échap recommence",
  "multiSplit.noTargets": "Rien à découper ici : sélectionnez des éléments ou choisissez un étage contenant des murs, poutres ou dalles",
  "multiSplit.needLine": "Dessinez d’abord la ligne de coupe avec deux points",
  "multiSplit.crossesNothing": "La ligne ne traverse aucun élément qu’elle peut découper",
  "multiSplit.nothingSplittable": "Tous les éléments traversés sont refusés : aucune découpe possible",
  "multiSplit.scope.selection": {"one":"Sélection : {countDisplay} élément","other":"Sélection : {countDisplay} éléments","many":"Sélection : {countDisplay} éléments"},
  "multiSplit.scope.storey": {"one":"Étage : {countDisplay} mur, poutre ou dalle","other":"Étage : {countDisplay} murs, poutres et dalles","many":"Étage : {countDisplay} murs, poutres et dalles"},
  "multiSplit.bar.splits": {"one":"{countDisplay} sera découpé","other":"{countDisplay} seront découpés","many":"{countDisplay} seront découpés"},
  "multiSplit.bar.refused": {"one":"{countDisplay} refusé","other":"{countDisplay} refusés","many":"{countDisplay} refusés"},
  "multiSplit.refused.otherModel": "Appartient à un autre modèle que celui en cours de modification",
  "multiSplit.refused.column": "Découpe impossible : une coupe verticale ne traverse pas un poteau dans sa longueur",
  "multiSplit.refused.vertical": "Découpe impossible : une barre verticale n’a aucun axe en plan à traverser",
  "multiSplit.refused.nearEnd": "Découpe impossible : la ligne passe à moins de {min} cm d’une extrémité",
  "multiSplit.done": {"one":"{countDisplay} élément découpé","other":"{countDisplay} éléments découpés","many":"{countDisplay} éléments découpés"},
  "multiSplit.leftAlone": {"one":"{countDisplay} élément traversé est resté inchangé (voir la raison à côté)","other":"{countDisplay} éléments traversés sont restés inchangés (voir la raison à côté de chacun)","many":"{countDisplay} éléments traversés sont restés inchangés (voir la raison à côté de chacun)"},
  "multiSplit.openingsSkipped": {"one":"{countDisplay} ouverture n’a pas pu être réaffectée et peut nécessiter un repositionnement manuel","other":"{countDisplay} ouvertures n’ont pas pu être réaffectées et peuvent nécessiter un repositionnement manuel","many":"{countDisplay} ouvertures n’ont pas pu être réaffectées et peuvent nécessiter un repositionnement manuel"},
  "commandPalette.tool.splitMulti.label": "Découper par une ligne",
} satisfies Catalogue;
