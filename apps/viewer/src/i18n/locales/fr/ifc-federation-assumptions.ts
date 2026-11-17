/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const ifcFederationAssumptionsFr = {
  "settings.ifcFederation.title": "Fédération IFC",
  "settings.ifcFederation.sharedVertical": "Supposer que les modèles IFC partagent un système altimétrique",
  "settings.ifcFederation.hint": "Désactivé par défaut. N'activez cette option que si vous savez que les modèles IFC et le modèle d'ancrage utilisent le même système altimétrique. Lorsqu'un référentiel vertical est absent ou non résolu, les hauteurs sont placées telles que saisies. Une hypothèse erronée place les modèles trop haut ou trop bas. Des référentiels déclarés différents restent refusés. Les noms non reconnus qui ne peuvent pas être rapprochés sont également refusés. Rechargez ou réalignez la fédération pour appliquer les modifications.",
  "settings.ifcFederation.assumed": "Système altimétrique supposé",
  "settings.ifcFederation.appliedUnresolved": "Selon votre paramètre, les hauteurs IFC sont supposées partager le système altimétrique du modèle d'ancrage. Un référentiel vertical saisi n'a pas pu être résolu ; les déclarations sources restent inchangées.",
  "settings.ifcFederation.applied": "Selon votre paramètre, les hauteurs IFC sont supposées partager le système altimétrique du modèle d'ancrage. Un référentiel vertical est absent ; les déclarations sources restent inchangées.",
} satisfies Catalogue;
