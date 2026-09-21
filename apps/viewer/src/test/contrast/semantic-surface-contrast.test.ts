/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DocumentPreview } from '../../components/viewer/document/DocumentPreview';
import { DOCUMENT_VERSION } from '../../lib/document/types';
import { CoordRow } from '../../components/viewer/properties/CoordinateDisplay';
import { closeContrastBrowser, measureTextContrastOnSurface, measureTextHoverColors, type Theme } from './render-harness';
import { extractClassNameAfter } from './extract-classname';
import { WCAG_AA_NORMAL_TEXT } from './wcag';

const THEMES: Theme[] = ['light', 'dark', 'colorful'];
const HERE = dirname(fileURLToPath(import.meta.url));
const SEARCHABLE_SELECT = join(HERE, '../../components/viewer/SearchableSelect.tsx');
const EXECUTABLE_CODE_BLOCK = join(HERE, '../../components/viewer/chat/ExecutableCodeBlock.tsx');
const MODEL_TAG_EDITOR = join(HERE, '../../components/viewer/hierarchy/ModelTagEditor.tsx');

function classContaining(markup: string, token: string): string {
  const classes = [...markup.matchAll(/class="([^"]+)"/g)].map((match) => match[1]);
  const found = classes.find((className) => className.split(/\s+/).includes(token));
  assert.ok(found, `expected rendered markup to contain ${token}`);
  return found;
}

function renderDocumentPreview(): string {
  return renderToStaticMarkup(createElement(DocumentPreview, {
    document: { version: DOCUMENT_VERSION, id: 'contrast', name: 'Contrast preview', page: { size: 'A4', orientation: 'portrait' }, blocks: [] },
    bindings: { models: [], activeModelId: null, today: new Date('2026-01-01') },
    aggregations: new Map(),
    chartMessages: new Map(),
    topics: new Map(),
    selectedBlockId: null,
    onSelectBlock: () => undefined,
  }));
}

function renderSecondaryCoordinate(): string {
  return renderToStaticMarkup(createElement(CoordRow, {
    label: 'Position',
    values: [{ axis: 'X', value: 1 }],
    primary: false,
    copyLabel: 'position',
    coordCopied: null,
    onCopy: () => undefined,
  }));
}

after(async () => {
  await closeContrastBrowser();
});

describe('semantic text surfaces meet WCAG AA (#4792)', () => {
  for (const theme of THEMES) {
    it(`primary foreground clears AA on primary in ${theme}`, async () => {
      const ratio = await measureTextContrastOnSurface(theme, 'bg-primary', 'text-primary-foreground');
      assert.ok(ratio >= WCAG_AA_NORMAL_TEXT, `primary contrast was ${ratio.toFixed(2)}:1 in ${theme}`);
    });

    it(`muted foreground clears AA on muted in ${theme}`, async () => {
      const ratio = await measureTextContrastOnSurface(theme, 'bg-muted', 'text-muted-foreground', 'bg-background');
      assert.ok(ratio >= WCAG_AA_NORMAL_TEXT, `muted contrast was ${ratio.toFixed(2)}:1 in ${theme}`);
    });

    for (const textToken of [
      'text-neutral-900',
      'text-neutral-700',
      'text-neutral-500',
      'document-preview-muted',
    ]) {
      it(`document preview ${textToken} clears AA on fixed paper in ${theme}`, async () => {
        const markup = renderDocumentPreview();
        const documentPaperClass = classContaining(markup, 'document-preview-paper');
        const textClass = textToken === 'document-preview-muted'
          ? classContaining(markup, textToken)
          : textToken;
        const ratio = await measureTextContrastOnSurface(theme, documentPaperClass, textClass);
        assert.ok(ratio >= WCAG_AA_NORMAL_TEXT, `document preview ${textClass} contrast was ${ratio.toFixed(2)}:1 in ${theme}`);
      });
    }

    it(`search empty-state text clears AA on its real popover surface in ${theme}`, async () => {
      const searchEmptyClass = extractClassNameAfter(SEARCHABLE_SELECT, '{filtered.length === 0 && (\n              <div ');
      const ratio = await measureTextContrastOnSurface(
        theme,
        'popover-surface bg-white dark:bg-zinc-800',
        searchEmptyClass,
      );
      assert.ok(ratio >= WCAG_AA_NORMAL_TEXT, `search empty-state contrast was ${ratio.toFixed(2)}:1 in ${theme}`);
    });

    for (const surface of ['bg-white', 'bg-zinc-50', 'bg-zinc-100']) {
      it(`enabled zinc-400 text clears AA on ${surface} in ${theme}`, async () => {
        const ratio = await measureTextContrastOnSurface(theme, surface, 'text-zinc-400', 'bg-background');
        assert.ok(ratio >= WCAG_AA_NORMAL_TEXT, `zinc-400 on ${surface} was ${ratio.toFixed(2)}:1 in ${theme}`);
      });
    }

    for (const [name, surface, resolveTextClass, fallback] of [
      ['execution duration', 'bg-muted', () => extractClassNameAfter(
        EXECUTABLE_CODE_BLOCK,
        "result.status !== 'running' && (\n              <span ",
      ), 'bg-background'],
      ['coordinate label', 'bg-background', () => classContaining(renderSecondaryCoordinate(), 'uppercase'), undefined],
      ['coordinate value', 'bg-background', () => classContaining(renderSecondaryCoordinate(), 'tabular-nums'), undefined],
    ] as const) {
      it(`${name} clears AA on its surface in ${theme}`, async () => {
        const textClass = resolveTextClass();
        const ratio = await measureTextContrastOnSurface(theme, surface, textClass, fallback);
        assert.ok(ratio >= WCAG_AA_NORMAL_TEXT, `${name} contrast was ${ratio.toFixed(2)}:1 in ${theme}`);
      });
    }
  }

  it('keeps ModelTagEditor hover feedback above the light zinc-400 correction', async () => {
    const deleteButtonClass = extractClassNameAfter(
      MODEL_TAG_EDITOR,
      'onClick={() => deleteModelTag(tag.id)}\n                  ',
    );
    const colors = await measureTextHoverColors('light', deleteButtonClass, 'text-red-500');
    assert.notEqual(colors.before, colors.after, 'hover must visibly change the delete action');
    assert.equal(colors.after, colors.expected, 'hover:text-red-500 must win the accessible base ink override');
  });
});
