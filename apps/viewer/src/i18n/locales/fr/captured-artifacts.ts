/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const capturedArtifactsFr = {
  'capturedArtifacts.population': 'Population',
  'capturedArtifacts.all': 'Tous les éléments correspondant à ces critères dans les fichiers chargés',
  'capturedArtifacts.selectedCaption': { one: '{count} élément sélectionné capturé depuis {files}', many: '{count} d’éléments sélectionnés capturés depuis {files}', other: '{count} éléments sélectionnés capturés depuis {files}' },
  'capturedArtifacts.visibleCaption': { one: '{count} élément visible capturé depuis {files}', many: '{count} d’éléments visibles capturés depuis {files}', other: '{count} éléments visibles capturés depuis {files}' },
  'capturedArtifacts.files': { one: '{count} fichier', many: '{count} de fichiers', other: '{count} fichiers' },
  'capturedArtifacts.captureSelected': 'Capturer la sélection',
  'capturedArtifacts.captureVisible': 'Capturer les éléments visibles',
  'capturedArtifacts.clear': 'Effacer la capture',
  'capturedArtifacts.captureFailed': 'Impossible de capturer ces éléments.',
} satisfies Catalogue;
