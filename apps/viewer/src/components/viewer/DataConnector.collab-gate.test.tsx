/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `DataConnector` mirror of `BulkPropertyEditor.collab-gate.test.tsx`.
 * CSV import reaches `MutablePropertyView.setProperty()` through
 * `CsvConnector.importAsync()`, bypassing the store's `setProperty` action —
 * and with it `canCollabEdit()` — exactly as bulk edit does, so the same two
 * layers apply here: `CsvConnector` is constructed with the store's
 * `canCollabEdit` predicate (see `packages/mutations/src/mutation-guard.ts`),
 * and the component disables its own Import button via `canEditInSession`.
 *
 * As in the bulk-editor file, "no mutation lands" cannot pin the UI layer —
 * the engine guard would keep it true with the component's gate deleted. So
 * this asserts the Import button's `title`, which is the sharpest observable
 * available here: unlike `disabled` (already true for six unrelated reasons
 * before a CSV is loaded), the tooltip is set if and only if the component
 * computed `canEditInSession` false. Making `disabled` meaningful would mean
 * driving the whole upload/mapping flow through a `FileReader`; the tooltip
 * needs no fixture file and can fail for exactly one reason.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup, click, advance } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { DataConnector } from './DataConnector.js';

const MODEL_ID = 'model-a';

function seedStore(collabRole: 'viewer' | 'editor' | null) {
  const seeded = fixtureModels(
    fixtureModel(MODEL_ID, {
      entities: [{ expressId: 42, type: 'IfcWall', name: 'Wall A' }],
    }),
  );
  useViewerStore.setState({
    ...seeded,
    mutationViews: new Map(),
    mutationVersion: 0,
    collabRole,
  });
}

async function openAndFindImportButton(): Promise<HTMLButtonElement> {
  const container = render(<DataConnector trigger={<button>Open</button>} />);
  const trigger = [...container.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('Open'),
  );
  assert.ok(trigger, 'dialog trigger button must render');
  click(trigger!);
  await advance(0);

  const importBtn = [...document.body.querySelectorAll('button')].find((b) => {
    const text = b.textContent?.trim() ?? '';
    return text === 'Import' || /^Import \d+ rows$/.test(text);
  }) as HTMLButtonElement | undefined;
  assert.ok(importBtn, 'Import button must render in the dialog footer');
  return importBtn!;
}

describe('DataConnector — collab role gate on CSV import', () => {
  afterEach(() => {
    cleanup();
  });

  it('a viewer-role participant sees the Import button carry the collab tooltip', async () => {
    seedStore('viewer');
    const importBtn = await openAndFindImportButton();
    assert.equal(
      importBtn.title,
      'Editing requires editor access in this shared session',
      'the Import button must explain why editing is blocked for a viewer role',
    );
    assert.equal(importBtn.disabled, true, 'the Import button must be disabled for a viewer role');
  });

  it('an editor-role participant sees no collab tooltip on the Import button', async () => {
    seedStore('editor');
    const importBtn = await openAndFindImportButton();
    assert.equal(
      importBtn.title,
      '',
      'an editor role must not be told editing is blocked (title is left unset)',
    );
  });

  it('a single-user session (null role) sees no collab tooltip on the Import button', async () => {
    seedStore(null);
    const importBtn = await openAndFindImportButton();
    assert.equal(
      importBtn.title,
      '',
      'outside a shared room the local editing rules apply, so no collab tooltip',
    );
  });
});
