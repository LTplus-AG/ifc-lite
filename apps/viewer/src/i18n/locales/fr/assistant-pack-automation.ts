/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const assistantPackAutomationFr = {
  "assistantSources.flowRun.title": "Exécution Flow",
  "assistantSources.flowRun.description": "Dernière exécution du graphe ouvert : résultats des nœuds, avertissements, sorties et fichiers produits.",
  "assistantSources.flowRun.rows": "Les lignes présentent d’abord les résultats des nœuds en échec (avec les liens entrants et les paramètres des seuls nœuds en échec et de ceux qui les alimentent, sans code source des scripts et avec les identifiants masqués), puis les avertissements, les fichiers produits (métadonnées uniquement), les sorties du graphe, les autres résultats et les entrées du journal.",
  "assistantSources.flowRun.unavailable": "Aucun résultat Flow n’était disponible lors de la capture. Exécutez le graphe dans Flow et actualisez les éléments de contexte.",
  "assistantSources.flowRun.discussRun": "Discuter de l’exécution avec l’IA",
  "assistantSources.flowRun.suggestExplain": "Expliquer ce que cette exécution a fait et produit",
  "assistantSources.flowRun.suggestFix": "Pourquoi des nœuds ont-ils échoué ou émis des avertissements, et comment les corriger ?",
  "assistantSources.flowRun.statusRunning": "Exécution en cours…",
  "assistantSources.flowRun.statusOk": {"one":"Réussite · {count} nœud","other":"Réussite · {count} nœuds","many":"Réussite · {count} nœuds"},
  "assistantSources.flowRun.statusFailed": {"one":"Échec · {count} nœud","other":"Échec · {count} nœuds","many":"Échec · {count} nœuds"},
  "assistantSources.flowRun.statusError": "L’exécution a échoué avant de produire un résultat",
  "assistantSources.flowRun.statusNone": "Aucune exécution pour le moment",
  "assistantSources.script.description": "Dernière exécution du script : valeur renvoyée, diagnostics et sortie de la console.",
  "assistantSources.script.rows": "Les lignes présentent la valeur renvoyée, les diagnostics et les entrées du journal. Le code source du script est exclu.",
  "assistantSources.script.unavailable": "Aucune exécution de script n’était disponible lors de la capture. Exécutez un script dans l’éditeur de scripts et actualisez les éléments de contexte.",
  "assistantSources.script.suggestExplain": "Expliquer ce que cette exécution de script a renvoyé et consigné",
  "assistantSources.script.suggestFix": "Pourquoi ce script a-t-il échoué et comment le corriger ?",
  "assistantSources.script.statusRunning": "Exécution en cours…",
  "assistantSources.script.statusError": "La dernière exécution a échoué",
  "assistantSources.script.statusResult": {"one":"Dernière exécution · {count} entrée du journal","other":"Dernière exécution · {count} entrées du journal","many":"Dernière exécution · {count} entrées du journal"},
  "assistantSources.script.statusDiagnostics": {"one":"{count} diagnostic","other":"{count} diagnostics","many":"{count} diagnostics"},
  "assistantSources.script.statusNone": "Aucune exécution pour le moment",
  "assistantSources.document.description": "Blocs, liaisons et paramètres de page du document ouvert.",
  "assistantSources.document.rows": "Les lignes présentent les blocs dans l’ordre du document. Le texte est celui du modèle avant résolution ; les images et graphiques sont limités aux métadonnées.",
  "assistantSources.document.unavailable": "Aucun document n’était ouvert lors de la capture. Ouvrez un document et actualisez les éléments de contexte.",
  "assistantSources.document.suggestReview": "Examiner la structure de ce document et proposer des améliorations",
  "assistantSources.document.suggestBindings": "À quels champs du modèle ce document fait-il référence ?",
  "assistantSources.document.status": {"one":"{name} · {count} bloc","other":"{name} · {count} blocs","many":"{name} · {count} blocs"},
  "assistantSources.document.statusNone": "Aucun document ouvert",
} satisfies Catalogue;
