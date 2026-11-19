/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { Catalogue } from '../../registry';

export const clashQualityFr = {
  'clashQuality.detectionExclusions': 'Exclusions de détection des ouvertures et éléments hôtes : {value}',
  'clashQuality.enabled': 'Activées',
  'clashQuality.disabled': 'Désactivées',
  'clashQuality.title': 'Critères de qualité',
  'clashQuality.configure': 'Configurer les critères de qualité',
  'clashQuality.clash': 'Contrôles des collisions',
  'clashQuality.duplicates': 'Contrôles des doublons',
  'clashQuality.minimum': 'Pourcentage minimal d’objets sans anomalie',
  'clashQuality.label': 'Nom de la catégorie',
  'clashQuality.color': 'Couleur de la catégorie',
  'clashQuality.newCategory': 'Nouvelle catégorie',
  'clashQuality.add': 'Ajouter une catégorie',
  'clashQuality.remove': 'Supprimer la catégorie',
  'clashQuality.save': 'Enregistrer les seuils',
  'clashQuality.saved': 'Seuils des critères de qualité enregistrés',
  'clashQuality.failed': 'Impossible d’enregistrer les seuils des critères de qualité',
  'clashQuality.invalid': 'Commencez à 0 %, utilisez des minimums croissants jusqu’à 100 % et nommez chaque catégorie.',
  'clashQuality.policy': 'Les objets sans anomalie sont les objets distincts contrôlés sans constat détecté. Les deux objets de chaque paire sont comptés ; chaque objet est compté une seule fois. Les exclusions de résultats, le statut de révision et les filtres d’affichage ne modifient pas ce score. Les exclusions de détection des ouvertures et éléments hôtes restent applicables. Les contrôles des doublons incluent tous les objets concernés, et pas seulement les copies en excès.',
  'clashQuality.counts': '{checked} contrôlés · {affected} concernés',
  'clashQuality.metric': 'Objets sans constat détecté',
  'clashQuality.not-evaluated': 'Non évalué',
  'clashQuality.unavailable': 'Périmètre de contrôle indisponible',
  'clashQuality.incomplete': 'Exécution incomplète',
  'clashQuality.outdated': 'Exécution obsolète',
  'clashQuality.document': 'Ajouter les critères de qualité à la documentation',
  'clashQuality.documentFailed': 'Impossible d’enregistrer le document des critères de qualité',
  'clashQuality.models': 'Modèles : {models}',
  'clashQuality.tolerance': 'Tolérance : {tolerance} m',
  'clashQuality.clearance': 'Distance libre : {clearance} m',
  'clashQuality.captured': 'Enregistré le : {when}',
  'clashQuality.revision': 'Révision des modifications du modèle : {revision}',
  'clashQuality.unknown': 'Inconnu',
} satisfies Catalogue;
