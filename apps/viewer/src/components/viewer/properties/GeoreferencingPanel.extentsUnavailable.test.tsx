/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #10608 review: when the bundled EPSG extents cannot be loaded, the lookup
 * results and the panel's out-of-area warning say the area of use is
 * unavailable instead of showing nothing, which would read as "EPSG records no
 * area of use for this code".
 */
import '@/test/setup-dom.js';
import { register } from 'node:module';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { IfcParser, extractGeoreferencingOnDemand } from '@ifc-lite/parser';
import { advance, cleanup, click, render, type } from '@/test/render.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';

register('../../../test/epsg-extents-unavailable.mjs', import.meta.url);
const { EpsgLookupDialog } = await import('./EpsgLookupDialog');
const { GeoreferencingPanel } = await import('./GeoreferencingPanel');
const { useViewerStore } = await import('@/store');

const FIXTURES = new URL('../../../../../../packages/georef-check/fixtures/', import.meta.url);
const UNAVAILABLE = 'Area of use unavailable.';
const initialState = useViewerStore.getState();

afterEach(() => {
  cleanup();
  useViewerStore.setState(initialState, true);
});

/** Poll until `text()` says the area of use is unavailable, or give up after 15 s. */
async function untilUnavailable(text: () => string): Promise<string> {
  for (const deadline = Date.now() + 15_000; Date.now() < deadline && !text().includes(UNAVAILABLE);) await advance(25);
  return text();
}

it('a lookup result says its area of use is unavailable when the EPSG extents fail to load (#10608)', async () => {
  const host = render(<EpsgLookupDialog onSelect={() => {}} />);
  const trigger = host.querySelector('button');
  assert.ok(trigger, 'the lookup trigger renders');
  click(trigger);
  const input = document.querySelector<HTMLInputElement>('[role="dialog"] input');
  assert.ok(input, 'the lookup dialog opens');
  type(input, '2056');
  const text = await untilUnavailable(() => [...document.querySelectorAll('[role="dialog"] button')]
    .find((b) => b.querySelector('code')?.textContent === '2056')?.textContent ?? '');
  assert.match(text, /Area of use unavailable\./, 'the 2056 result says its area of use could not be loaded');
  assert.doesNotMatch(text, /longitude/, 'and shows no box');
});

it('the out-of-area warning says the area of use is unavailable when the EPSG extents fail to load (#10608)', async () => {
  const bytes = new Uint8Array(readFileSync(new URL('outside-area-swapped.ifc', FIXTURES)));
  const store = await new IfcParser().parseColumnar(bytes.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
  useViewerStore.setState({ ...fixtureModels({ ...fixtureModel('m'), ifcDataStore: store }), georefMutations: new Map() });
  const host = render(<GeoreferencingPanel georef={extractGeoreferencingOnDemand(store)} schemaVersion="IFC4" modelId="m" lengthUnitScale={0.001} />);
  const text = await untilUnavailable(() => [...host.querySelectorAll('[role="alert"]')]
    .find((a) => a.textContent?.includes('Outside the area of use'))?.textContent ?? '');
  assert.match(text, /Outside the area of use of EPSG:2056\./, 'the warning still shows');
  assert.match(text, /Area of use unavailable\./, 'and says its box could not be loaded');
});
