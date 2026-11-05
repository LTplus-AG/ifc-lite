/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const landXmlGeorefAssumptionsFr = {
  "landXmlGeorefAssumptions.sharedVerticalDatum.label": "Supposer un système altimétrique commun",
  "landXmlGeorefAssumptions.sharedVerticalDatum.description": "Lorsque le fichier LandXML ou le modèle sur lequel il est placé n'indique pas le système altimétrique de ses hauteurs, les hauteurs sont placées telles qu'écrites, comme si les deux utilisaient le même. Si ce n'est pas le cas, la surface est trop haute ou trop basse de l'écart entre les deux systèmes altimétriques.",
  "landXmlGeorefAssumptions.epsgFromName.label": "Lire un code EPSG dans le nom du système de coordonnées",
  "landXmlGeorefAssumptions.epsgFromName.description": "Lorsque le CoordinateSystem LandXML ne donne aucun code EPSG mais que son nom est exactement « EPSG: » suivi d'un nombre (par exemple EPSG:31467), ce code est utilisé. Aucun autre nom n'est jamais lu. Si le nom n'était qu'un libellé, la surface se retrouve au mauvais endroit.",
  "landXmlGeorefAssumptions.title": "Le fichier LandXML « {fileName} » n'a pas pu être aligné avec le modèle",
  "landXmlGeorefAssumptions.offer": "Il peut être placé si vous acceptez :",
  "landXmlGeorefAssumptions.load": "Charger avec ces hypothèses",
  "landXmlGeorefAssumptions.always": "Toujours supposer ceci",
  "landXmlGeorefAssumptions.alwaysHint": "« Toujours supposer ceci » active aussi les hypothèses cochées dans Paramètres, Général, pour tous les fichiers LandXML suivants. Vous pouvez les y désactiver à nouveau.",
  "landXmlGeorefAssumptions.cancel": "Annuler",
  "landXmlGeorefAssumptions.settings": "Géoréférencement LandXML",
  "landXmlGeorefAssumptions.settingsHint": "Les deux options sont désactivées par défaut : un fichier LandXML qui n'indique pas comment il s'aligne sur le modèle est refusé, et le message nomme ce qui manque. N'en activez une que si elle s'applique à vos fichiers. Un modèle placé ainsi est marqué « Supposé ».",
  "landXmlGeorefAssumptions.badge": "Supposé",
  "landXmlGeorefAssumptions.assumed": "Placé à l'aide des hypothèses que vous avez choisies",
  "landXmlGeorefAssumptions.sharedVerticalDatum.applied": "Hauteurs supposées partager le système altimétrique du modèle d'ancrage : aucun référentiel vertical n'est déclaré.",
  "landXmlGeorefAssumptions.epsgFromName.applied": "{crs} lu dans le nom du CoordinateSystem : aucun code EPSG n'est déclaré.",
} satisfies Catalogue;
