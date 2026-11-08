/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const clashGroupsIt = {
  "clashGroups.expand": "Espandi {name}",
  "clashGroups.collapse": "Comprimi {name}",
  "clashGroups.focus": "Metti a fuoco ogni oggetto di questo gruppo",
  "clashGroups.addToGroup": "Aggiungi le interferenze selezionate a questo gruppo",
  "clashGroups.createBcf": "Crea un argomento BCF da questo gruppo",
  "clashGroups.rename": "Rinomina questo gruppo",
  "clashGroups.ungroup": "Separa queste interferenze dal gruppo",
  "clashGroups.select": "Seleziona l'interferenza tra {first} e {second}",
  "clashGroups.selectForGrouping": "Seleziona questa interferenza per il raggruppamento manuale",
  "clashGroups.removeMember": "Rimuovi questa interferenza dal gruppo",
  "clashGroups.createTitle": "Raggruppa interferenze selezionate",
  "clashGroups.renameTitle": "Rinomina gruppo di interferenze",
  "clashGroups.addToGroupTitle": "Aggiungi interferenze al gruppo",
  "clashGroups.createDescription": {
    "one": "{count} interferenza selezionata apparirà come un unico problema di coordinamento espandibile.",
    "other": "{count} interferenze selezionate appariranno come un unico problema di coordinamento espandibile.",
    "many": "{count} interferenze selezionate appariranno come un unico problema di coordinamento espandibile."
  },
  "clashGroups.renameDescription": "L'appartenenza al gruppo resta invariata.",
  "clashGroups.addToGroupDescription": {
    "one": "{count} interferenza selezionata verrà aggiunta a {name}.",
    "other": "{count} interferenze selezionate verranno aggiunte a {name}.",
    "many": "{count} interferenze selezionate verranno aggiunte a {name}."
  },
  "clashGroups.alreadyGroupedError": "Rimuovi le interferenze già raggruppate dal gruppo attuale prima di aggiungerle altrove.",
  "clashGroups.name": "Nome del gruppo",
  "clashGroups.cancel": "Annulla",
  "clashGroups.create": "Crea gruppo",
  "clashGroups.add": "Aggiungi",
  "clashGroups.saveName": "Salva nome",
  "clashGroups.view.pairs": "Coppie",
  "clashGroups.view.issues": "Problemi",
  "clashGroups.view.groups": "Gruppi",
  "clashGroups.viewTitle": "I problemi raggruppano coppie vicine entro {distance} m; i gruppi sono scelti e denominati da te",
  "clashGroups.issuePairs": "{issues} · {pairs}",
  "clashGroups.groupPairs": "{groups} · {pairs}",
  "clashGroups.clashSummary": "{clashes}",
  "clashGroups.clashSummaryShown": "{clashes} · {shown} visualizzati",
  "clashGroups.clashSummaryIssues": "{clashes} · {issues}",
  "clashGroups.clashSummaryShownIssues": "{clashes} · {shown} visualizzati · {issues}",
  "clashGroups.issueCount": {
    "one": "{count} problema",
    "other": "{count} problemi",
    "many": "{count} problemi"
  },
  "clashGroups.groupCount": {
    "one": "{count} gruppo",
    "other": "{count} gruppi",
    "many": "{count} gruppi"
  },
  "clashGroups.pairCount": {
    "one": "{count} coppia",
    "other": "{count} coppie",
    "many": "{count} coppie"
  },
  "clashGroups.clashCount": {
    "one": "{count} interferenza",
    "other": "{count} interferenze",
    "many": "{count} interferenze"
  },
  "clashGroups.severity.critical": "Critica",
  "clashGroups.severity.major": "Grave",
  "clashGroups.severity.minor": "Minore",
  "clashGroups.severity.info": "Informativa",
  "clashGroups.workspace": "Spazio di raggruppamento",
  "clashGroups.defaultWorkspace": "Gruppi manuali di interferenze",
  "clashGroups.storageNotReady": "L'archiviazione dei gruppi non è pronta oppure la partizione di appartenenza non è valida. Conserva questa bozza e riprova dopo il ripristino."
} satisfies Catalogue;
