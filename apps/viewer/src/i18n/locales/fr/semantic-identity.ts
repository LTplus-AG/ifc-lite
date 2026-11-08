/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const semanticIdentityFr = {
  'semantic.identityControls': 'Stratégie d’identité IFC',
  'semantic.identityUri': 'L’URI de ressource contient le GlobalId IFC',
  'semantic.identityUriMode': 'Correspondance des URI de ressource',
  'semantic.identityUriTemplateMode': 'Modèle d’URI complet',
  'semantic.identityUriSegmentMode': 'Dernier segment du chemin (sur option)',
  'semantic.identityUriTemplate': 'Modèle d’URI de ressource complet',
  'semantic.identityUriApply': 'Appliquer le modèle d’URI',
  'semantic.identityUriHint': 'Le modèle utilise un seul espace réservé {GlobalId}. Le dernier segment du chemin nécessite des URI de ressource connus pour les requêtes inverses. La correspondance d’URI ne remplace jamais la stratégie GlobalId directe sélectionnée.',
  'semantic.identityDirect': 'GlobalId IFC et révision du modèle',
  'semantic.identityLinks': 'Liens de ressource explicites',
  'semantic.identityProfile': 'Champs d’identité du profil',
  'semantic.identityGuidField': 'Champ GlobalId du profil',
  'semantic.identityRevisionField': 'Champ de révision du profil',
  'semantic.identityNoRevision': 'Aucun champ de révision',
  'semantic.identityLinkJson': 'Liens de ressource (JSON)',
  'semantic.identityApplyLinks': 'Appliquer les liens de ressource',
  'semantic.identityLinkHint': 'Utilisez resourceId, modelRevision et GlobalId. Les révisions de modèle nécessitent une association explicite à un modèle chargé.',
} satisfies Catalogue;
