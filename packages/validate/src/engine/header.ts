/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** ISO 10303-21 HEADER checks: FILE_DESCRIPTION and FILE_NAME attribute types (header_section_schema). */

import { headerRecords } from '../runtime/step-reader.js';
import type { ValidationFinding } from './findings.js';

const HEADER_ATTRIBUTES: Record<string, Array<[name: string, list: boolean]>> = {
  FILE_DESCRIPTION: [['description', true], ['implementation_level', false]],
  FILE_NAME: [
    ['name', false], ['time_stamp', false], ['author', true], ['organization', true],
    ['preprocessor_version', false], ['originating_system', false], ['authorization', false],
  ],
};

function isHeaderString(value: unknown): boolean {
  return typeof value === 'string' && (value.length <= 256 || Array.from(value).length <= 256);
}

export function checkHeader(text: string, out: ValidationFinding[]): void {
  const records = headerRecords(text);
  if (!records.size) {
    out.push({ category: 'header', rule: 'header-section', message: 'No HEADER section' });
    return;
  }
  for (const [entity, attributes] of Object.entries(HEADER_ATTRIBUTES)) {
    const values = records.get(entity);
    if (!values) {
      out.push({ category: 'header', rule: `${entity}`, message: `${entity} is missing or unreadable` });
      continue;
    }
    attributes.forEach(([name, list], i) => {
      const v = values[i];
      const ok = list ? Array.isArray(v) && v.length > 0 && v.every(isHeaderString) : isHeaderString(v);
      if (!ok) {
        out.push({
          category: 'header', rule: `${entity}.${name}`, attribute: `${entity}.${name}`,
          message: `Expected ${list ? 'LIST [1:?] OF STRING (256)' : 'STRING (256)'}`,
        });
      }
    });
  }
}
