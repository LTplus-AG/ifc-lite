/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const influxFr = {
  "influx.title": "InfluxDB 2",
  "influx.experimental": "Expérimental",
  "influx.help": "Télémétrie synthétique ou en direct, en lecture seule, associée par GlobalId IFC. Sélectionnez un IfcSpace ou un IfcSensor dans le modèle.",
  "influx.bounds": "Charge la dernière heure, jusqu'à 10 000 échantillons. Un dépassement ou des données non valides font échouer tout le chargement. Les unités d'affichage sont des libellés, pas des conversions.",
  "influx.url": "URL InfluxDB",
  "influx.org": "Organisation",
  "influx.bucket": "Bucket",
  "influx.measurement": "Measurement",
  "influx.field": "Champ numérique",
  "influx.guidTag": "Clé de tag du GUID",
  "influx.unit": "Unité d'affichage",
  "influx.token": "Jeton (en mémoire uniquement)",
  "influx.load": "Charger",
  "influx.loading": "Chargement…",
  "influx.loaded": "{samples} échantillons chargés.",
  "influx.select": "Sélectionnez un IfcSpace ou un IfcSensor associé de manière unique pour voir sa valeur.",
  "influx.latest": "Dernière valeur : {value} {unit}",
  "influx.history": "Historique de {name} : {samples} échantillons",
  "influx.timestamp": "Dernier échantillon : {time}",
  "influx.unmatched": "Séries non associées ({count})",
  "influx.ambiguous": "Séries ambiguës ({count}) : aucune association effectuée",
  "influx.none": "Aucune",
  "influx.error.config": "Vérifiez tous les champs de connexion. Utilisez HTTPS, ou http://localhost pour le développement. Les identifiants, chaînes de requête et fragments sont interdits dans l'URL.",
  "influx.error.network": "Erreur CORS ou réseau. Le serveur InfluxDB doit autoriser l'origine de cette visionneuse, ou vous pouvez utiliser une passerelle à amont fixe.",
  "influx.error.http": "InfluxDB a refusé la requête. Vérifiez l'organisation, le bucket et les droits de lecture du jeton.",
  "influx.error.data": "Échec du chargement : données mal formées, tronquées, trop volumineuses, non numériques ou contradictoires, table d'erreur, ou plus de 10 000 échantillons. Réduisez les données sources avant de réessayer.",
  "influx.error.storage": "La configuration n'a pas pu être enregistrée. Vérifiez l'accès au stockage du navigateur.",
} satisfies Catalogue;
