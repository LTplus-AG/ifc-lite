/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const workspaceMigrationFr = {
  'workspaceMigration.layout.title': 'Vérifiez votre disposition mise à jour',
  "workspaceMigration.layout.summary": {"one": "{count} modification de disposition est prête à être vérifiée. Votre travail enregistré est préservé.", "many": "{count} modifications de disposition sont prêtes à être vérifiées. Votre travail enregistré est préservé.", "other": "{count} modifications de disposition sont prêtes à être vérifiées. Votre travail enregistré est préservé."},
  'workspaceMigration.layout.showChanges': 'Afficher les modifications',
  'workspaceMigration.layout.hideChanges': 'Masquer les modifications',
  'workspaceMigration.layout.keep': 'Conserver la disposition',
  'workspaceMigration.layout.reset': 'Réinitialiser la disposition',
  'workspaceMigration.layout.added': '{panel} ajouté après {anchor}.',
  'workspaceMigration.layout.addedTop': '{panel} ajouté à la liste des panneaux.',
  'workspaceMigration.layout.renamed': '{from} renommé en {panel}.',
  'workspaceMigration.layout.restored': '{panel} rétabli dans la liste des panneaux.',
  'workspaceMigration.layout.preserved': 'L’emplacement indisponible {id} est conservé pour plus tard.',
  'workspaceMigration.layout.regrouped': 'Groupes de panneaux mis à jour.',
  'workspaceMigration.layout.mode': 'Mode de la barre latérale mis à jour.',
  'workspaceMigration.layout.unreadable': 'La disposition enregistrée est illisible. L’original est conservé pour récupération.',
  'workspaceMigration.placement.title': 'Emplacements d’extension indisponibles',
  'workspaceMigration.placement.notRendered': 'La visionneuse n’a aucune surface pour {slot}. L’emplacement est préservé.',
  'workspaceMigration.placement.hostOwned': 'La visionneuse gère {slot} ; les extensions ne peuvent pas remplacer cette surface.',
  'workspaceMigration.placement.unknownSlot': 'L’emplacement {slot} est inconnu. Le placement est préservé.',
  'workspaceMigration.deepLink.copy': 'Copier le lien',
  'workspaceMigration.deepLink.copyNamed': 'Copier le lien vers {name}',
  'workspaceMigration.deepLink.copied': 'Lien copié',
  'workspaceMigration.deepLink.copyFailed': 'Le lien n’a pas pu être copié.',
  'workspaceMigration.deepLink.failed': 'L’élément lié n’a pas pu être ouvert.',
  'workspaceMigration.deepLink.busy': 'Attendez la fin de la requête en cours, puis rouvrez le lien.',
  'workspaceMigration.deepLink.unavailable': 'L’élément lié n’est pas disponible dans ce navigateur.',
  'workspaceMigration.deepLink.missingConversation': 'Cette conversation enregistrée est introuvable dans ce navigateur.',
  'workspaceMigration.deepLink.missingReceipt': 'Ce reçu de requête est introuvable dans cette session.',
  'workspaceMigration.deepLink.missingBcfDraft': 'Ce brouillon BCF est introuvable dans ce navigateur.',
  'workspaceMigration.deepLink.unknownPanel': 'Le lien désigne un panneau inconnu.',
  'workspaceMigration.deepLink.conflicting': 'Le lien contient des destinations contradictoires.',
  'workspaceMigration.deepLink.invalidId': 'Le lien contient un identifiant d’élément non valide.',
} satisfies Catalogue;
