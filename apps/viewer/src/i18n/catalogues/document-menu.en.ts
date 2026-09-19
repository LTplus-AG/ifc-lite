/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

export const documentMenuEn = {
  'documentMenu.namePrompt': 'Document name',
  'documentMenu.copySuffix': '{name} (copy)',
  'documentMenu.imported': 'Imported document "{name}"',
  'documentMenu.importFailed': 'Failed to import the document',
  'documentMenu.importFailedWithReason': 'Failed to import the document: {reason}',
  'documentMenu.actions': 'Document actions',
  'documentMenu.actionsTitle': 'Rename, duplicate, delete, export or import a document',
  'documentMenu.rename': 'Rename',
  'documentMenu.duplicate': 'Duplicate',
  'documentMenu.delete': 'Delete',
  'documentMenu.exportTemplate': 'Export template…',
  'documentMenu.importTemplate': 'Import template…',
} as const satisfies Record<string, TranslationValue>;
