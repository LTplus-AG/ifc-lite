/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Browser half of the `.checklist.json` file (#6401): download through the
 * one sanctioned save path (`lib/export/download.ts`) and read a picked
 * `File`. Parsing/validation is `checklist.ts`, DOM-free.
 */

import { trackExportCompleted } from '@/lib/analytics';
import { downloadFile, sanitizeFilename } from '../../export/download.js';
import { parseChecklistText, serializeChecklist, type ChecklistParseResult, type ChecklistTemplate } from './checklist.js';

/** Download `template` as `<name>.checklist.json` and return the text written. */
export function exportChecklist(template: ChecklistTemplate): string {
  const text = serializeChecklist(template);
  const name = sanitizeFilename(template.name, { fallback: 'checklist' });
  downloadFile(text, `${name}.checklist.json`, 'application/json');
  trackExportCompleted({ format: 'json', surface: 'ids_panel' });
  return text;
}

/** Read + parse a picked `.checklist.json`. Never rejects. */
export async function importChecklistFile(file: File): Promise<ChecklistParseResult> {
  let text: string;
  try {
    text = await file.text();
  } catch (err) {
    console.warn('[ifc-lite] a checklist file could not be read.', err);
    return { ok: false, error: 'the file could not be read' };
  }
  return parseChecklistText(text);
}
