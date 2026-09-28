/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useState } from 'react';
import { cleanup, press, render, type } from '@/test/render.js';
import { ClashRuleDraftEditor, type ClashRuleDraft } from './ClashRuleDraftEditor.js';
import { TextAnnotationEditor } from './TextAnnotationEditor.js';

afterEach(cleanup);

describe('persistent input names (#6342)', () => {
  it('names the rule and both type selectors after they are filled', () => {
    function RuleFixture() {
      const [draft, setDraft] = useState<ClashRuleDraft>({
        id: null, name: '', selectorA: '', selectorB: '', severity: 'critical',
      });
      return <ClashRuleDraftEditor
        draft={draft}
        severities={['critical']}
        severityLabel={() => 'Critical'}
        matchCount={() => null}
        hasModel={false}
        onChange={setDraft}
        onCancel={() => {}}
        onSave={() => {}}
        canSave
      />;
    }

    const host = render(<RuleFixture />);
    for (const [label, value] of [
      ['Rule name', 'Ducts versus walls'],
      ['Set A IFC type selector', 'IfcDuct*'],
      ['Set B IFC type selector', 'IfcWall*'],
    ]) {
      const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
      assert.ok(input, `${label} has a programmatic name`);
      type(input, value);
      assert.equal(input.value, value);
      assert.equal(input.getAttribute('aria-label'), label, 'name persists after typing');
    }
  });

  it('names annotation text while editing and still confirms it with Enter', () => {
    const confirmations: Array<[string, string]> = [];
    const host = render(<TextAnnotationEditor
      annotation={{
        id: 'note-1', position: { x: 0, y: 0 }, text: 'Initial note', fontSize: 14,
        color: '#000000', backgroundColor: '#ffffff', borderColor: '#000000',
      }}
      screenX={0}
      screenY={0}
      onConfirm={(id, value) => confirmations.push([id, value])}
      onCancel={() => {}}
    />);
    const editor = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Annotation text"]');
    assert.ok(editor, 'text annotation editor has a programmatic name');
    type(editor, 'Updated note');
    assert.equal(editor.getAttribute('aria-label'), 'Annotation text');
    press(editor, 'Enter');
    assert.deepEqual(confirmations, [['note-1', 'Updated note']]);
  });
});
