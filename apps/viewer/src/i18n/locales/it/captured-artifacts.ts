/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const capturedArtifactsIt = {
  'capturedArtifacts.population': 'Insieme di elementi',
  'capturedArtifacts.all': 'Tutti gli elementi che soddisfano questi criteri nei file caricati',
  'capturedArtifacts.selectedCaption': {
    one: '{count} elemento selezionato acquisito da {files}',
    many: '{count} elementi selezionati acquisiti da {files}',
    other: '{count} elementi selezionati acquisiti da {files}',
  },
  'capturedArtifacts.visibleCaption': {
    one: '{count} elemento visibile acquisito da {files}',
    many: '{count} elementi visibili acquisiti da {files}',
    other: '{count} elementi visibili acquisiti da {files}',
  },
  'capturedArtifacts.files': { one: '{count} file', many: '{count} file', other: '{count} file' },
  'capturedArtifacts.captureSelected': 'Acquisisci selezionati',
  'capturedArtifacts.captureVisible': 'Acquisisci visibili',
  'capturedArtifacts.clear': 'Cancella acquisizione',
  'capturedArtifacts.captureFailed': 'Impossibile acquisire questi elementi.',
} satisfies Catalogue;
