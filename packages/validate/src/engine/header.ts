/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** ISO 10303-21 HEADER checks: FILE_DESCRIPTION and FILE_NAME attribute types (header_section_schema). */

import { readStepRecord } from '../runtime/step-reader.js';
import type { Value } from '../runtime/values.js';
import type { ValidationFinding } from './findings.js';

const HEADER_ATTRIBUTES: Record<string, Array<[name: string, list: boolean]>> = {
  FILE_DESCRIPTION: [['description', true], ['implementation_level', false]],
  FILE_NAME: [
    ['name', false], ['time_stamp', false], ['author', true], ['organization', true],
    ['preprocessor_version', false], ['originating_system', false], ['authorization', false],
  ],
};

function headerEntity(header: string, name: string): Value[] | undefined {
  const at = header.search(new RegExp(`\\b${name}\\s*\\(`));
  if (at < 0) return undefined;
  const end = header.indexOf(');', at);
  try {
    return readStepRecord(`#0=${header.slice(at, end < 0 ? undefined : end + 1)}`).attributes;
  } catch {
    return undefined;
  }
}

export function checkHeader(text: string, out: ValidationFinding[]): void {
  const start = text.indexOf('HEADER;');
  const end = text.indexOf('ENDSEC;', start);
  if (start < 0 || end < 0) {
    out.push({ category: 'header', rule: 'header-section', message: 'No HEADER section' });
    return;
  }
  const header = text.slice(start, end);
  for (const [entity, attributes] of Object.entries(HEADER_ATTRIBUTES)) {
    const values = headerEntity(header, entity);
    if (!values) {
      out.push({ category: 'header', rule: `${entity}`, message: `${entity} is missing or unreadable` });
      continue;
    }
    attributes.forEach(([name, list], i) => {
      const v = values[i];
      const ok = list ? Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string') : typeof v === 'string';
      if (!ok) {
        out.push({
          category: 'header', rule: `${entity}.${name}`, attribute: `${entity}.${name}`,
          message: `Expected ${list ? 'LIST [1:?] OF STRING (256)' : 'STRING (256)'}`,
        });
      }
    });
  }
}
