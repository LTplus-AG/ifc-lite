/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The harness that makes viewer components mountable, tested (#2434).
 *
 * Three test files concluded that components like these "cannot be mounted
 * under `tsx --test`" (a fourth said it of the toolbars, via `@/icons`) and wrote source-text assertions instead. The conclusion
 * was wrong but the walls were real, and this file is what stops them being
 * rediscovered: it exercises each one against a component that actually hits
 * it, so a regression in the harness surfaces here rather than as a future
 * author quietly deciding the wall is back.
 *
 * `FileTab` is the subject because it hits BOTH loader hooks — it reaches
 * `@/icons` (unplugin-icons virtual modules) and, through `isCollabEnabled()`,
 * `import.meta.env`. Under a plain `tsx --test` it throws ERR_MODULE_NOT_FOUND
 * before a line of test code runs; the whole file goes red without the
 * `--import ./src/test/vite-module-hooks.mjs` flag in the viewer's `test`
 * script. That is the intended signal: these tests ARE the proof the flag is
 * load-bearing.
 */

import './setup-dom.js';
import { installLayout } from './dom-layout.js';

installLayout();

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup } from './render.js';
import { fixtureDataStore, fixtureModel, fixtureModels } from './store-fixture.js';
import { FileTab } from '@/components/viewer/ribbon/tabs/FileTab.js';

/** The six callbacks `FileTab` destructures; it throws on a missing prop. */
const FILE_COMMANDS = {
  handleOpenClick: () => {},
  handleAddClick: () => {},
  handleReloadClick: () => {},
  handleCloseClick: () => {},
  handleScreenshot: () => {},
  handleNewClick: () => {},
} as never;

describe('viewer test harness', () => {
  afterEach(() => cleanup());

  it('mounts a component that reaches ~icons and import.meta.env', () => {
    // Without vite-module-hooks.mjs this file does not even import: `~icons/*`
    // are Vite virtual modules Node has never heard of, and `import.meta.env`
    // is undefined so `isCollabEnabled()` throws on property access.
    const container = render(<FileTab fileCommands={FILE_COMMANDS} />);
    assert.ok(
      container.innerHTML.length > 1000,
      `expected a substantial render, got ${container.innerHTML.length} bytes`,
    );
  });

  it('substitutes every ~icons import with one real <svg>', () => {
    const container = render(<FileTab fileCommands={FILE_COMMANDS} />);
    // The stub renders a genuine element, so icons occupy layout and are
    // clickable the way the shipped ones are — a stub returning null would
    // let an icon-only control silently vanish from a test's reach.
    assert.ok(
      container.querySelector('[data-testid="icon-stub"]'),
      'no stubbed icon rendered; the ~icons resolve hook is not active',
    );
  });

  it('gives happy-dom a viewport, so measure-then-render components see one', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    // happy-dom returns 0 for all of these without installLayout(). A
    // virtualizer told its container is 0px high renders zero rows.
    assert.ok(el.getBoundingClientRect().height > 0);
    assert.ok(el.clientHeight > 0);
    el.remove();
  });

  it('delivers a ResizeObserver entry, which happy-dom never does on its own', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    let delivered: number | null = null;
    const observer = new ResizeObserver((entries) => {
      delivered = entries[0]?.contentRect.height ?? null;
    });
    observer.observe(el);
    observer.disconnect();
    el.remove();
    // The real happy-dom ResizeObserver never fires, so this stays null and
    // @tanstack/react-virtual never learns its viewport.
    assert.ok(delivered !== null && delivered > 0, `no entry delivered (got ${delivered})`);
  });

  it('builds a data store that satisfies a panel gate without pretending to parse', () => {
    const store = fixtureDataStore([{ expressId: 7, type: 'IfcWall', name: 'W1' }]);
    assert.deepEqual([...store.entityIndex.byType.keys()], ['IFCWALL']);
    assert.equal(store.entities.getTypeName(7), 'IfcWall');
    assert.equal(store.entities.getName(7), 'W1');
    // idOffset is what toGlobalIdFromModels adds; a fixture with a non-zero
    // offset is what catches code that forgets to qualify an expressId.
    const { models, activeModelId } = fixtureModels(fixtureModel('m', { idOffset: 1_000_000 }));
    assert.equal(activeModelId, 'm');
    assert.equal(models.get('m')?.idOffset, 1_000_000);
  });
});
