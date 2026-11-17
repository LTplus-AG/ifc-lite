/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const flowStartupFr = {
  "flowStartup.optIn": "Proposer ce flux de travail au démarrage",
  "flowStartup.title": "Ouvrir votre flux de travail enregistré ?",
  "flowStartup.description": "Ouvrez « {name} » pour choisir les fichiers et vérifier les paramètres, puis cliquez sur Exécuter lorsque vous êtes prêt.",
  "flowStartup.open": "Ouvrir le flux de travail",
  "flowStartup.skip": "Ignorer pour cette session",
  "flowStartup.disable": "Désactiver l’invite au démarrage",
  "flowStartup.storageError": "Impossible d’enregistrer la préférence de démarrage : {reason}",
} satisfies Catalogue;
