/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The STEP `HEADER` section `IfcCreator.toIfc()` writes. Split out of
 * `ifc-creator.ts` alongside the other emitter modules; it is a pure function
 * of the creation instant, the author fields and the schema tag.
 */

import { esc } from './ifc-creator-math.js';

export function buildStepHeader(nowMs: number, author: string, organization: string, schema: string): string {
  // ISO 8601 time_stamp: keep '-'/':', drop only milliseconds and the 'Z'.
  const now = new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, '');
  const app = 'ifc-lite';
  return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('${esc('Created by ifc-lite')}'),'2;1');
FILE_NAME('created.ifc','${now}',('${esc(author)}'),('${esc(organization)}'),'${app}','${app}','');
FILE_SCHEMA(('${schema}'));
ENDSEC;
`;
}
