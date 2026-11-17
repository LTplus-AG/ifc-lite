/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const ionUploadFr = {
  "ionUpload.title": "Téléverser vers Cesium ion",
  "ionUpload.description": "Téléversez un modèle IFC avec ses modifications en attente vers votre compte Cesium ion. Toutes les propriétés du modèle sont incluses.",
  "ionUpload.close": "Fermer",
  "ionUpload.upload": "Téléverser",
  "ionUpload.uploading": "Téléversement…",
  "ionUpload.abort": "Annuler le téléversement",
  "ionUpload.successTitle": "Envoyé pour le tuilage",
  "ionUpload.errorTitle": "Le téléversement n'a pas abouti",
  "ionUpload.accepted": "Cesium ion a accepté le téléversement et va le tuiler. Ouvrez la ressource pour suivre la progression et vérifier le placement.",
  "ionUpload.cancelled": "Téléversement annulé. Toute ressource déjà créée reste dans Cesium ion ; vous pouvez l'y supprimer.",
  "ionUpload.failed": "Échec de l'étape « {phase} » (HTTP {status}). {help}",
  "ionUpload.failure.authorization": "Le jeton ne peut pas créer de ressources. Utilisez un jeton avec la portée assets:write (le jeton par défaut est en lecture seule) et vérifiez ses URL autorisées dans Cesium ion.",
  "ionUpload.failure.conflict": "Cesium ion a refusé la demande de téléversement. Si une nouvelle tentative échoue, signalez cette erreur avec son statut HTTP.",
  "ionUpload.failure.capacity": "Vérifiez l'abonnement du compte, le quota de stockage et la taille du téléversement dans Cesium ion avant de réessayer.",
  "ionUpload.failure.rateLimit": "Cesium ion limite les requêtes. Patientez avant de réessayer.",
  "ionUpload.failure.service": "Cesium ion n'a pas pu traiter cette requête. Vérifiez l'état du service avant de réessayer.",
  "ionUpload.failure.request": "Vérifiez la connexion et la ressource dans Cesium ion avant de réessayer. Le téléversement n'a peut-être pas abouti.",
  "ionUpload.exportWarnings": { one: "La préparation de l'IFC pour Cesium ion a signalé un problème ; rien n'a donc été téléversé.", other: "La préparation de l'IFC pour Cesium ion a signalé {count} problèmes ; rien n'a donc été téléversé.", many: "La préparation de l'IFC pour Cesium ion a signalé {count} de problèmes ; rien n'a donc été téléversé." },
  "ionUpload.serializationFailed": "Impossible de préparer l'IFC modifié. Essayez d'exporter l'IFC localement pour vérifier le modèle.",
  "ionUpload.texturesUnsupported": "Ce modèle contient des ressources d'image. Exportez un IFCZIP localement pour conserver ses images. Le téléversement direct des textures n'est pas encore pris en charge.",
  "ionUpload.noModel": "Chargez un modèle IFC STEP à téléverser. IFCX et LandXML ne sont pas pris en charge.",
  "ionUpload.openAsset": "Voir {name} dans Cesium ion",
  "ionUpload.model": "Modèle",
  "ionUpload.token": "Jeton Cesium ion (assets:write)",
  "ionUpload.tokenHelp": "Utilisez un jeton distinct disposant de l'autorisation assets:write. Il est conservé en mémoire jusqu'à la fermeture de cette boîte de dialogue, et n'est jamais enregistré ni envoyé aux outils d'analyse.",
  "ionUpload.createToken": "Créer un jeton",
  "ionUpload.placement": "Le téléversement conserve le géoréférencement de votre IFC. Les noms de référentiel vertical EVRS2007 ou EGM2008 reconnus sont téléversés comme hauteur au-dessus du niveau de la mer EGM2008. Tout autre texte de référentiel est conservé. Après le tuilage, vérifiez la position, l'orientation et l'altitude dans Cesium ion. Pour les modèles sans géoréférencement, définissez leur position là-bas.",
  "ionUpload.phase.serialize": "Préparation de l'IFC modifié…",
  "ionUpload.phase.create": "Création de la ressource…",
  "ionUpload.phase.upload": "Téléversement de l'IFC…",
  "ionUpload.phase.complete": "Démarrage du tuilage…",
} satisfies Catalogue;
