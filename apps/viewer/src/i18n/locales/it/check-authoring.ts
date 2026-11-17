/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const checkAuthoringIt = {
  "checkAuthoring.proposalIds": "Bozza IDS",
  "checkAuthoring.proposalRules": "Bozza di regole informative",
  "checkAuthoring.proposalDocument": "Struttura del rapporto",
  "checkAuthoring.proposalIdsSummary": {
    "one": "{count} specifica",
    "other": "{count} specifiche",
    "many": "{count} specifiche"
  },
  "checkAuthoring.proposalRulesSummary": {
    "one": "{count} regola",
    "other": "{count} regole",
    "many": "{count} regole"
  },
  "checkAuthoring.proposalDocumentSummary": {
    "one": "{count} sezione",
    "other": "{count} sezioni",
    "many": "{count} sezioni"
  },
  "checkAuthoring.proposalUnsupported": {
    "one": "{count} requisito non verificabile",
    "other": "{count} requisiti non verificabili",
    "many": "{count} requisiti non verificabili"
  },
  "assistant.suggestIdsDraft": "Prepara una bozza di specifiche IDS da revisionare: ",
  "assistant.suggestRulesDraft": "Prepara una bozza di regole informative (unicità, conteggi, confronti) da revisionare: ",
  "assistant.suggestReportOutline": "Delinea un rapporto di validazione con tabelle dei risultati in tempo reale",
  "checkAuthoring.idsTitle": "Revisiona bozza IDS",
  "checkAuthoring.rulesTitle": "Revisiona regole informative",
  "checkAuthoring.documentTitle": "Revisiona struttura del rapporto",
  "checkAuthoring.draftTitle": "Titolo",
  "checkAuthoring.namesRequired": "Ogni titolo e specifica deve avere un nome.",
  "checkAuthoring.specifications": "Specifiche in bozza",
  "checkAuthoring.specName": "Nome della specifica",
  "checkAuthoring.specCardinality": "Elementi applicabili",
  "checkAuthoring.cardinality.required": "Obbligatorio",
  "checkAuthoring.cardinality.optional": "Facoltativo",
  "checkAuthoring.cardinality.prohibited": "Vietato",
  "checkAuthoring.appliesTo": "Si applica a",
  "checkAuthoring.requires": "Richiede",
  "checkAuthoring.requirementCardinality": "Requisito",
  "checkAuthoring.requiredValue": "Valore richiesto",
  "checkAuthoring.requiredValueIn": "Valore richiesto ({unit})",
  "checkAuthoring.unitConversion": "Redatto in {unit}, memorizzato in SI: {values}",
  "checkAuthoring.unitPair": "{authored} {unit} → {si} {siUnit}",
  "checkAuthoring.auditRunning": "Esecuzione dell'audit IDS nativo…",
  "checkAuthoring.auditSummary": "Audit IDS nativo: {errors} errori, {warnings} avvisi",
  "checkAuthoring.auditFailed": "Impossibile eseguire l'audit IDS nativo ({reason}), quindi salvataggio ed esportazione restano bloccati. Modifica la bozza per eseguirlo di nuovo.",
  "checkAuthoring.auditIssues": "Problemi dell'audit IDS",
  "checkAuthoring.auditIssue": "{path}: {message}",
  "checkAuthoring.unsupportedTitle": "Non verificabile nativamente",
  "checkAuthoring.unsupportedHint": "Conservati con la bozza salvata per la revisione manuale; nessun controllo automatico li copre.",
  "checkAuthoring.unsupportedReason": "({reason})",
  "checkAuthoring.unsupportedReasonFor": "({reason}; {name})",
  "checkAuthoring.dryRun": "Esecuzione di prova sui modelli caricati",
  "checkAuthoring.cancelDryRun": "Annulla esecuzione di prova",
  "checkAuthoring.dryRunResults": "Risultati dell'esecuzione di prova",
  "checkAuthoring.dryRunOn": {
    "one": "Esecuzione di prova su {count} modello (nessun salvataggio o cambio di colore)",
    "other": "Esecuzione di prova su {count} modelli (nessun salvataggio o cambio di colore)",
    "many": "Esecuzione di prova su {count} modelli (nessun salvataggio o cambio di colore)"
  },
  "checkAuthoring.skippedModels": {
    "one": "{count} modello caricato non ha dati analizzati e non è stato controllato.",
    "other": "{count} modelli caricati non hanno dati analizzati e non sono stati controllati.",
    "many": "{count} modelli caricati non hanno dati analizzati e non sono stati controllati."
  },
  "checkAuthoring.dryRunStale": "La bozza o i modelli sono cambiati dopo questa esecuzione di prova. Rieseguila prima di salvare.",
  "checkAuthoring.counts": "{applicable} applicabili · {passed} superati · {failed} non superati",
  "checkAuthoring.failedSets": {
    "one": "{count} insieme con esito negativo",
    "other": "{count} insiemi con esito negativo",
    "many": "{count} insiemi con esito negativo"
  },
  "checkAuthoring.zeroPopulation": {
    "one": "Nessun elemento nel modello caricato è applicabile, quindi questo controllo non valuta ancora nulla.",
    "other": "Nessun elemento nei {count} modelli caricati è applicabile, quindi questo controllo non valuta ancora nulla.",
    "many": "Nessun elemento nei {count} modelli caricati è applicabile, quindi questo controllo non valuta ancora nulla."
  },
  "checkAuthoring.cardinalityModel": "{model}: {message}",
  "checkAuthoring.unevaluable": "Impossibile valutare: {error}",
  "checkAuthoring.sampleFailures": "Esempi di esiti negativi di {name}",
  "checkAuthoring.showInModel": "Mostra {name} nel modello",
  "checkAuthoring.moreFailures": {
    "one": "{count} altro elemento con esito negativo",
    "other": "{count} altri elementi con esito negativo",
    "many": "{count} altri elementi con esito negativo"
  },
  "checkAuthoring.warningSeverity": "(avviso)",
  "checkAuthoring.saveNeedsDryRun": "Per salvare serve un'esecuzione di prova di questa esatta bozza sui modelli attuali.",
  "checkAuthoring.saveIds": "Salva nella libreria IDS",
  "checkAuthoring.exportIds": "Esporta .ids",
  "checkAuthoring.idsSaved": "Salvato nella libreria IDS di Validazione dati. L'IDS attivo e il risultato visualizzato restano invariati finché non apri questo.",
  "checkAuthoring.openIds": "Apri in Validazione dati",
  "checkAuthoring.ruleSetName": "Nome dell'insieme di regole",
  "checkAuthoring.rules": "Regole in bozza",
  "checkAuthoring.ruleName": "Nome della regola",
  "checkAuthoring.severity": "Gravità",
  "checkAuthoring.severityError": "Errore",
  "checkAuthoring.severityWarning": "Avviso",
  "checkAuthoring.ruleCardinality": "Elementi applicabili: da {min} a {max}",
  "checkAuthoring.saveRules": "Salva come insieme di regole",
  "checkAuthoring.rulesSaved": "Salvato negli insiemi di regole informative. L'insieme attivo e il risultato visualizzato restano invariati finché non apri questo.",
  "checkAuthoring.openRules": "Apri nell'editor delle regole",
  "checkAuthoring.documentHint": "Le tabelle mostrano il rapporto di validazione attuale ogni volta che il documento viene visualizzato o stampato; il testo è una bozza non verificata.",
  "checkAuthoring.sections": "Sezioni della struttura",
  "checkAuthoring.sectionHeading": "Titolo della sezione",
  "checkAuthoring.textBlock": "Testo",
  "checkAuthoring.validationTable": "Tabella di validazione",
  "checkAuthoring.allChecks": "ogni controllo",
  "checkAuthoring.liveRows": {
    "one": "in tempo reale: {count} riga, modalità {rows}, ora per {target}",
    "other": "in tempo reale: {count} righe, modalità {rows}, ora per {target}",
    "many": "in tempo reale: {count} righe, modalità {rows}, ora per {target}"
  },
  "checkAuthoring.liveRuleMissing": "{target} non è nel rapporto di validazione attuale",
  "checkAuthoring.liveEvidenceChanged": "{target} è stato redatto a partire da un rapporto di validazione diverso da quello ora visualizzato",
  "checkAuthoring.liveNoReport": "nessun rapporto di validazione caricato; la tabella mostrerà le righe per {target} dopo un'esecuzione",
  "checkAuthoring.pageBreak": "Interruzione di pagina",
  "checkAuthoring.validationSummary": "Riepilogo di validazione (istantanea del rapporto nativo)",
  "checkAuthoring.saveDocument": "Salva come nuovo documento",
  "checkAuthoring.documentSaved": "Salvato nella libreria Documenti.",
  "checkAuthoring.openDocument": "Apri in Documenti"
} satisfies Catalogue;
