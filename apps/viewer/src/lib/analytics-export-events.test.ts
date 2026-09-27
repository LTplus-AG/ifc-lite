/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { beforeSend } from './analytics.js';
import { type ExportCompletedProperties } from './analytics-export-events.js';

describe('export completion privacy contract (#5844)', () => {
  it('keeps a fixed surface and aggregate metrics through the actual send gate', () => {
    const properties: ExportCompletedProperties = {
      format: 'ifc-anonymized', surface: 'palette', seed_count: 2,
      included_count: 15, model_count: 2, relation_toggles: ['voids', 'aggregates'], anonymize_names: true,
    };
    const sent = beforeSend({
      event: 'export_completed',
      properties: { ...properties, file_name: 'Confidential.ifc', $set: { email: 'private' }, bogus: 42 },
    });
    assert.deepEqual(sent?.properties, properties);
  });

  it('rejects free text, unknown surfaces, and invalid counts while retaining SDK keys', () => {
    const sent = beforeSend({
      event: 'export_completed',
      properties: {
        format: 'csv', surface: 'C:\\client\\tower.ifc', row_count: -1,
        relation_toggles: ['voids', 'client name'], token: 'sdk', $set_once: { name: 'secret' },
      },
    });
    assert.equal(sent, null, 'an unattributed export must never leave the browser');
  });

  it('strips malformed optional metrics while keeping a valid completion', () => {
    const sent = beforeSend({
      event: 'export_completed',
      properties: {
        format: 'csv', surface: 'classic', row_count: -1,
        relation_toggles: ['voids', 'client name'], token: 'sdk',
      },
    });
    assert.deepEqual(sent?.properties, { format: 'csv', surface: 'classic', token: 'sdk' });
  });

  it('keeps only a safe model count through the global privacy scrubber (#5844)', () => {
    const sent = beforeSend({
      event: 'export_completed',
      properties: { format: 'ifc', surface: 'classic', model_count: 3, model_name: 'Private Tower.ifc' },
    });
    assert.deepEqual(sent?.properties, { format: 'ifc', surface: 'classic', model_count: 3 });
    const malformed = beforeSend({
      event: 'export_completed',
      properties: { format: 'ifc', surface: 'classic', model_count: 1.5 },
    });
    assert.deepEqual(malformed?.properties, { format: 'ifc', surface: 'classic' });
  });
});
