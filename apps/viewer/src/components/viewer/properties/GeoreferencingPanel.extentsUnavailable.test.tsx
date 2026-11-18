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
import { extractGeoreferencingOnDemand } from '@ifc-lite/parser';
import { advance, cleanup, click, render, type } from '@/test/render.js';

register('../../../test/epsg-extents-unavailable.mjs', import.meta.url);
const { EpsgLookupDialog } = await import('./EpsgLookupDialog');
const { GeoreferencingPanel } = await import('./GeoreferencingPanel');
const { useViewerStore } = await import('@/store');
const { georefCheckFixture, seedGeorefModel } = await import('@/test/georef-check-fixture.js');

const UNAVAILABLE = 'Area of use unavailable.';
const initialState = useViewerStore.getState();

afterEach(() => {
  cleanup();
  useViewerStore.setState(initialState, true);
});

/** Poll until `find()` returns an element, or give up after 15 s. */
async function until<T extends Element>(find: () => T | undefined, what: string): Promise<T> {
  for (const deadline = Date.now() + 15_000; Date.now() < deadline; await advance(25)) {
    const found = find();
    if (found) return found;
  }
  const found = find();
  assert.ok(found, `${what} never rendered`);
  return found;
}

/** The element under `root` matching `selector` whose whole text is `text`. */
function byText(root: ParentNode, selector: string, text: string): Element | undefined {
  return [...root.querySelectorAll(selector)].find((el) => el.textContent?.trim() === text);
}

it('a lookup result says its area of use is unavailable when the EPSG extents fail to load (#10608)', async () => {
  const host = render(<EpsgLookupDialog onSelect={() => {}} />);
  const trigger = host.querySelector('button');
  assert.ok(trigger, 'the lookup trigger renders');
  click(trigger);
  const input = document.querySelector<HTMLInputElement>('[role="dialog"] input');
  assert.ok(input, 'the lookup dialog opens');
  type(input, '2056');
  const row = await until(() => byText(document, '[role="dialog"] button code', '2056')?.closest('button') ?? undefined, 'the 2056 result');
  await until(() => byText(row, 'div', UNAVAILABLE), 'the unavailable line in the 2056 result');
  assert.equal([...row.querySelectorAll('div')].some((div) => /longitude/.test(div.textContent ?? '')), false, 'and the row shows no box');
});

it('the out-of-area warning says the area of use is unavailable when the EPSG extents fail to load (#10608)', async () => {
  const store = await georefCheckFixture('outside-area-swapped');
  seedGeorefModel(store);
  const host = render(<GeoreferencingPanel georef={extractGeoreferencingOnDemand(store)} schemaVersion="IFC4" modelId="m" lengthUnitScale={0.001} />);
  const heading = await until(() => byText(host, '[role="alert"] strong', 'Outside the area of use of EPSG:2056.'), 'the out-of-area warning');
  const body = heading.parentElement;
  assert.ok(body, 'the heading sits in the warning text');
  assert.ok(body.textContent?.trim().endsWith(UNAVAILABLE), 'the warning ends by saying its box could not be loaded');
});
