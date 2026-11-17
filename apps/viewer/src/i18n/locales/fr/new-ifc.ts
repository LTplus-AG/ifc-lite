/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const newIfcFr = {
  "newIfc.title": "Réviser le nouveau fichier IFC",
  "newIfc.scope": "Créer uniquement un nouveau projet, un site et un bâtiment natifs ainsi que les étages fournis. Les unités et altitudes doivent être fournies ; aucune géométrie d’élément ni exigence de conception n’est déduite.",
  "newIfc.noUndo": "Cette action crée un fichier distinct. Le téléchargement et le remplacement d’une session de la visionneuse ne sont pas des modifications de création et ne disposent pas de l’annulation du modèle.",
  "newIfc.prepare": "Préparer le nouveau fichier IFC",
  "newIfc.preparing": "Préparation du fichier natif…",
  "newIfc.preview": "{name} : {bytes} octets, {count} enregistrements natifs ; {schema}, {unit}.",
  "newIfc.defaults": "Identités, noms et valeurs par défaut natifs",
  "newIfc.content": "Contenu IFC préparé exact",
  "newIfc.download": "Télécharger l’IFC révisé",
  "newIfc.downloaded": "Les octets approuvés ont été fournis via l’action native de téléchargement.",
  "newIfc.loadWarning": "Demander un chargement principal remplace la session actuelle de la visionneuse. Enregistrez d’abord les modifications en cours. Le chargement natif peut encore échouer ou être annulé.",
  "newIfc.requestLoad": "Demander le chargement dans la visionneuse (remplacer la session)",
  "newIfc.requested": "Chargement demandé, non confirmé. Consultez les rapports natifs d’activité et de chargement pour connaître le résultat réel.",
  "newIfc.modelsTitle": "Modèles et nouveaux fichiers IFC",
  "newIfc.modelsDescription": "Discutez des rapports réels de chargement des modèles ou préparez une structure IFC native autonome à partir du schéma, des unités et des étages fournis.",
  "newIfc.capabilityReady": "Création native d’une structure de fichier disponible ; aucune donnée de modèle chargé",
  "newIfc.suggest": "Prépare un nouveau projet IFC natif et ses étages avec le schéma, les unités et les altitudes que je fournis ; demande toute information manquante.",
} satisfies Catalogue;
