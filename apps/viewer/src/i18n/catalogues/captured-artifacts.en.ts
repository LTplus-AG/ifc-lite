/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { TranslationValue } from '../types';
export const capturedArtifactsEn = {
  'capturedArtifacts.population': 'Population',
  'capturedArtifacts.all': 'All elements matching these criteria in loaded files',
  'capturedArtifacts.selectedCaption': { one: '{count} selected element captured from {files}', other: '{count} selected elements captured from {files}' },
  'capturedArtifacts.visibleCaption': { one: '{count} visible element captured from {files}', other: '{count} visible elements captured from {files}' },
  'capturedArtifacts.files': { one: '{count} file', other: '{count} files' },
  'capturedArtifacts.captureSelected': 'Capture selected',
  'capturedArtifacts.captureVisible': 'Capture visible',
  'capturedArtifacts.clear': 'Clear capture',
  'capturedArtifacts.captureFailed': 'Could not capture these elements.',
} as const satisfies Record<string, TranslationValue>;
