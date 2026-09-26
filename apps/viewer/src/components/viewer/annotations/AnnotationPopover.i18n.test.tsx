/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `AnnotationPopover`'s own chrome reads the i18n catalogue (#4918 slice:
 * annotations, `annotations.en.ts`): the dialog aria-label/close button, the
 * edit-mode textarea placeholder/hints/buttons, the read-mode empty-note
 * hint and edit/delete titles, and the relative-time phrasing. The
 * annotation's own note TEXT is model content and stays literal through a
 * locale switch — it is asserted separately from the pseudo-marked catalogue
 * keys, never itself marked by the pseudo-locale.
 *
 * Dynamic + guarded import (not a static one): a revert of this slice's
 * production change deletes `annotations.en.ts` entirely, and a static
 * `import { annotationsEn } from '...'` would fail this whole test FILE to
 * load (ERR_MODULE_NOT_FOUND) instead of letting the assertions below fail
 * on their own merits. The `describe` block itself is deliberately NOT
 * skipped when the catalogue is absent (unlike some earlier #4918 slices'
 * tests): every `CATALOGUE[key]` lookup below would return `undefined`, so
 * `assert.equal(typeof value, 'string')` goes red on its own — a real
 * ASSERTION_FAILURE the revert-oracle can attribute, rather than a
 * `describe.skip` collecting zero tests (NO_TESTS), which the oracle cannot
 * distinguish from a broken harness (#4918 revert-oracle lesson).
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import type { TranslationValue } from '@/i18n/types';
import type { annotationsEn as AnnotationsEnType } from '@/i18n/catalogues/annotations.en';
import type { Annotation } from '@/store/slices/annotationsSlice';
import { AnnotationPopover } from './AnnotationPopover.js';

let annotationsEn: typeof AnnotationsEnType | undefined;
try {
  ({ annotationsEn } = await import('@/i18n/catalogues/annotations.en'));
} catch {
  annotationsEn = undefined;
}
const CATALOGUE = annotationsEn ?? ({} as typeof AnnotationsEnType);

const marked = (text: string): string => `⟦${text}⟧`;

function pseudoLocale(): Catalogue {
  const catalogue: Record<string, TranslationValue> = {};
  for (const [key, value] of Object.entries(CATALOGUE) as [string, TranslationValue][]) {
    catalogue[key] = typeof value === 'string' ? marked(value) : { one: marked(value.one ?? value.other), other: marked(value.other) };
  }
  return catalogue;
}

const PSEUDO_LOCALE = 'annotations-popover-pseudo';

function readableStrings(root: ParentNode): Set<string> {
  const out = new Set<string>();
  root.querySelectorAll('*').forEach((el) => {
    for (const attr of ['aria-label', 'title', 'placeholder']) {
      const value = el.getAttribute(attr);
      if (value) out.add(value);
    }
    const ownText = [...el.childNodes]
      .filter((n) => n.nodeType === n.TEXT_NODE)
      .map((n) => n.textContent ?? '')
      .join('')
      .trim();
    if (ownText) out.add(ownText);
  });
  return out;
}

function makeAnnotation(overrides: Partial<Annotation> = {}): Annotation {
  const now = Date.now();
  return {
    id: 'ann-1',
    position: { x: 0, y: 0, z: 0 },
    modelId: null,
    entityExpressId: null,
    note: 'Check this detail before pouring the slab.',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as Annotation;
}

beforeEach(() => {
  setLocale('en');
});

afterEach(() => {
  cleanup();
  setLocale('en');
});

describe('AnnotationPopover localization (#4918)', () => {
  it('translates read-mode chrome and keeps the note text literal', () => {
    const annotation = makeAnnotation();
    const container = render(
      <AnnotationPopover
        annotation={annotation}
        anchorX={100}
        anchorY={100}
        boundaryEl={null}
        entityType={null}
        onSave={() => {}}
        onDelete={() => {}}
        onClose={() => {}}
      />,
    );
    const english = readableStrings(container);
    assert.ok(english.has(annotation.note), 'the annotation note must render as-is');

    registerLocale(PSEUDO_LOCALE, pseudoLocale());
    act(() => setLocale(PSEUDO_LOCALE));
    const after = readableStrings(container);
    act(() => setLocale('en'));

    for (const key of ['annotations.popover.ariaLabel', 'annotations.popover.headerFallbackLabel', 'annotations.popover.closeButtonTitle', 'annotations.popover.editButtonTitle', 'annotations.popover.deleteButtonTitle', 'annotations.popover.relativeJustNow'] as const) {
      const value = CATALOGUE[key];
      assert.equal(typeof value, 'string');
      assert.ok(english.has(value as string), `${key}: expected English text on screen before switch`);
      assert.ok(after.has(marked(value as string)), `${key}: expected marked text after switching locale`);
    }
    assert.ok(after.has(annotation.note), 'the annotation note must not be marked by the pseudo-locale');
  });

  it('translates edit-mode chrome for a fresh (empty-note) annotation', () => {
    const annotation = makeAnnotation({ note: '' });
    const container = render(
      <AnnotationPopover
        annotation={annotation}
        anchorX={100}
        anchorY={100}
        boundaryEl={null}
        entityType="IfcWall"
        onSave={() => {}}
        onDelete={() => {}}
        onClose={() => {}}
      />,
    );
    const english = readableStrings(container);
    registerLocale(PSEUDO_LOCALE, pseudoLocale());
    act(() => setLocale(PSEUDO_LOCALE));
    const after = readableStrings(container);
    act(() => setLocale('en'));

    for (const key of ['annotations.popover.placeholder', 'annotations.popover.keyHints', 'annotations.popover.cancelButton', 'annotations.popover.saveButton'] as const) {
      const value = CATALOGUE[key];
      assert.equal(typeof value, 'string');
      assert.ok(english.has(value as string), `${key}: expected English text on screen before switch`);
      assert.ok(after.has(marked(value as string)), `${key}: expected marked text after switching locale`);
    }
    // Entity TYPE names are model content, not catalogue keys.
    assert.ok(english.has('IfcWall'), 'the entity type name must render as-is');
    assert.ok(after.has('IfcWall'), 'the entity type name must not be marked by the pseudo-locale');
  });
});
