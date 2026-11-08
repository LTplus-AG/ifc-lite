/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The STEP `HEADER` section `IfcCreator.toIfc()` writes. Split out of
 * `ifc-creator.ts` alongside the other emitter modules; it is a pure function
 * of the creation instant, the author fields and the schema tag.
 */

import { esc } from './ifc-creator-math.js';

/** `FILE_NAME.name` written when the caller gives no `FileName`. */
const DEFAULT_FILE_NAME = 'created.ifc';
/** `FILE_DESCRIPTION.description` written when the caller gives no `FileDescription`. */
const DEFAULT_FILE_DESCRIPTION: readonly string[] = ['Created by ifc-lite'];

/** ISO 10303-21 declares both `FILE_NAME.name` and each description entry as `STRING (256)`. */
const MAX_HEADER_STRING = 256;

/** The `ProjectParams` fields the header reads. */
interface StepHeaderText {
  FileName?: string;
  FileDescription?: string | readonly string[];
}

function checkHeaderString(value: string, what: string): string {
  if (value.length > MAX_HEADER_STRING) {
    throw new RangeError(`${what} is ${value.length} characters; ISO 10303-21 allows at most ${MAX_HEADER_STRING}`);
  }
  return value;
}

export function buildStepHeader(nowMs: number, author: string, organization: string, schema: string, text: StepHeaderText = {}): string {
  // ISO 8601 time_stamp: keep '-'/':', drop only milliseconds and the 'Z'.
  const now = new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, '');
  const app = 'ifc-lite';
  const fileName = checkHeaderString(text.FileName ?? DEFAULT_FILE_NAME, 'FileName');
  const rawDescription = text.FileDescription ?? DEFAULT_FILE_DESCRIPTION;
  const description: readonly string[] = typeof rawDescription === 'string' ? [rawDescription] : rawDescription;
  // FILE_DESCRIPTION.description is LIST [1:?] OF STRING: an empty list is not a valid header.
  if (description.length === 0) throw new RangeError('FileDescription needs at least one entry');
  const descriptionList = description.map((d, i) => `'${esc(checkHeaderString(d, `FileDescription[${i}]`))}'`).join(',');
  return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((${descriptionList}),'2;1');
FILE_NAME('${esc(fileName)}','${now}',('${esc(author)}'),('${esc(organization)}'),'${app}','${app}','');
FILE_SCHEMA(('${schema}'));
ENDSEC;
`;
}
