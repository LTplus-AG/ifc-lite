/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const documentMenuFr = {
  "documentMenu.namePrompt": "Nom du document",
  "documentMenu.copySuffix": "{name} (copie)",
  "documentMenu.imported": "Document « {name} » importé",
  "documentMenu.importFailed": "Échec de l’import du document",
  "documentMenu.importFailedWithReason": "Échec de l’import du document : {reason}",
  "documentMenu.actions": "Actions du document",
  "documentMenu.actionsTitle": "Renommer, dupliquer, supprimer, exporter ou importer un document",
  "documentMenu.rename": "Renommer",
  "documentMenu.duplicate": "Dupliquer",
  "documentMenu.delete": "Supprimer",
  "documentMenu.exportTemplate": "Exporter le modèle de document…",
  "documentMenu.importTemplate": "Importer un modèle de document…",
} satisfies Catalogue;
