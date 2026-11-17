/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const spaceEnvelopeFr = {
  "spaceEnvelope.label": "Modifier l'enveloppe de l'espace",
  "spaceEnvelope.mode": "Forme du plafond",
  "spaceEnvelope.flat": "Plat",
  "spaceEnvelope.slope": "En pente",
  "spaceEnvelope.pitched": "À deux pans",
  "spaceEnvelope.floor": "Altitude du sol",
  "spaceEnvelope.left": "Altitude de l'avant-toit gauche",
  "spaceEnvelope.right": "Altitude de l'avant-toit droit",
  "spaceEnvelope.ridge": "Altitude du faîtage",
  "spaceEnvelope.pick": "Utilisez une vue de face ou en coupe. Cliquez sur une poignée de sol, d'avant-toit ou de faîtage ; déplacez puis cliquez pour appliquer. Entrée applique les altitudes saisies. Alt suspend l'accrochage.",
  "spaceEnvelope.move": "Approchez une arête ou un sommet de toiture pour vous y accrocher ; un clic ou Entrée applique une modification. Échap annule.",
  "spaceEnvelope.refused": "Sélectionnez un espace défini par l'extrusion verticale d'un rectangle ou d'un polygone. Utilisez une vue verticale dans le sens de la pente du toit. Les géométries maillées, mappées, trouées, inclinées ou illisibles ne peuvent pas être modifiées.",
  "spaceEnvelope.invalid": "Gardez le plafond au-dessus du sol et le faîtage entre les avant-toits. Un plafond à deux pans doit monter jusqu'à son faîtage.",
} satisfies Catalogue;
