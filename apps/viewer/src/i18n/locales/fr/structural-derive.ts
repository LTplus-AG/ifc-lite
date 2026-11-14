/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const structuralDeriveFr = {
  "structuralDerive.hint": "Les poutres, poteaux et barres deviennent des éléments linéaires ; les dalles et murs deviennent des éléments surfaciques sur leur plan moyen ; les extrémités qui se rejoignent partagent un nœud ; les fondations portent les appuis. Chaque élément dérivé est lié à son élément physique. Des enregistrements IFC sont créés ; la conception n’est pas vérifiée.",
  "structuralDerive.prepare": "Dériver et vérifier",
  "structuralDerive.acknowledgement": "J’ai vérifié les éléments ignorés et les appuis supposés.",
  "structuralDerive.counts": "Éléments linéaires : {curveMembers} · éléments surfaciques : {surfaceMembers} · nœuds : {nodes} · appuis : {supports}, dont supposés : {guessedSupports} · enregistrements IFC à créer : {created}",
  "structuralDerive.assumed": "Éléments sans valeur LoadBearing, supposés porteurs : {count}.",
  "structuralDerive.skipped": "Éléments ignorés ({count})",
  "structuralDerive.guessed": "Appuis supposés aux nœuds les plus bas, faute de fondation ({count})",
  "structuralDerive.unconnected": "Nœuds qui touchent un élément ou une surface sans y être reliés ({count})",
  "structuralDerive.existing": "Ce modèle possède déjà un modèle d'analyse ({ids}). Rien n'est dérivé à côté.",
  "structuralDerive.nothing": "Rien à dériver : aucun élément porteur n’a pu être idéalisé, ou chacun a déjà un équivalent structurel.",
  "structuralDerive.noModel": "Chargez un modèle pour dériver son modèle d’analyse structurelle.",
  "structuralDerive.nodeAt": "Nœud {node} : {position} m",
  "structuralDerive.endAt": "Nœud {node} : {position} m, {landsOn} #{element}",
  "structuralDerive.more": "{count} autres non affichés",
  "structuralDerive.model": "Modèle : {name}",
  "structuralDerive.moved": "Extrémités de barres déplacées le long de leur axe pour former un assemblage ({count})",
  "structuralDerive.movedRow": "#{element} {end} : {distance} m jusqu'à #{to}",
  "structuralDerive.free": "Extrémités libres, sans autre barre ni appui ({count})",
  "structuralDerive.end.start": "début",
  "structuralDerive.end.end": "fin",
  "structuralDerive.reason.already-idealised": "a déjà un équivalent structurel",
  "structuralDerive.reason.not-load-bearing": "non porteur",
  "structuralDerive.reason.load-bearing-unknown": "pas de valeur LoadBearing",
  "structuralDerive.reason.no-idealisable-shape": "forme non idéalisable",
  "structuralDerive.reason.shorter-than-tolerance": "plus court que la tolérance",
  "structuralDerive.reason.footing-without-member-end": "aucune extrémité sur cette fondation",
  "structuralDerive.landsOn.member-interior": "sur l’élément linéaire",
  "structuralDerive.landsOn.surface-member": "sur l’élément surfacique",
} satisfies Catalogue;
