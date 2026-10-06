/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { render, cleanup } from '@/test/render';
import { useViewerStore } from '@/store';
import type { TableMapping } from '@/lib/actions/table-mapping';
import { TableMappingCard } from './TableMappingCard';

const original = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(original, true); });

// #6912: a refused sample conversion says why; it never reads as a valid sample that changes nothing.
test('a refused sample conversion shows the refusal, not "no changes"', () => {
  const mapping: TableMapping = { version: 1, kind: 'table.mapping', title: 'Walls', identity: { column: 'GlobalId', key: 'GlobalId' },
    columns: [{ column: 'Fire', target: 'property', pset: 'Pset_WallCommon', name: 'FireRating', valueType: 'text' }] };
  const ui = render(<TableMappingCard modelId="not-loaded" headers={['GlobalId', 'Fire']} rows={[{ GlobalId: '1AQAupaRP1txwK1AGiN61V', Fire: 'EI60' }]}
    mapping={mapping} onChange={() => undefined} onReview={() => undefined} onDiscard={() => undefined} />);
  assert.match(ui.textContent ?? '', /The target model is not loaded\./);
  assert.doesNotMatch(ui.textContent ?? '', /The sample rows produce no changes\./);
});
