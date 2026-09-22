/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Regression coverage for the #4918 document-panel localization slice: BlockEditor.tsx's own
 *  chrome (the kind badge, per-kind fields, and move/remove controls) reads the catalogue and
 *  re-renders in a registered locale, for every block kind. */
import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { ChartSpec } from '@ifc-lite/charts';
import type { BCFTopic } from '@ifc-lite/bcf';
import { cleanup, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import type { BindingContext } from '@/lib/document/bindings';
import type { ChartBlock, IdsReportBlock, ImageBlock, SpacerBlock, TableBlock, TextBlock, TopicBlock } from '@/lib/document/types';
import { LIST_PRESETS } from '@/lib/lists';
import { BlockEditor } from './BlockEditor.js';

const BINDINGS: BindingContext = { models: [], activeModelId: null, today: new Date(0) };
const noop = (): void => {};

const TEST_LOCALE: Catalogue = {
  'document.block.kindText': 'Texte',
  'document.block.kindImage': 'Image_DE',
  'document.block.kindChart': 'Diagramm',
  'document.block.kindTopic': 'BCF-Thema',
  'document.block.kindSpacer': 'Abstand',
  'document.block.styleLabel': 'Stil',
  'document.block.textStyleAriaLabel': 'Textstil',
  'document.block.insertFieldLabel': 'Feld einfügen',
  'document.block.moveUpAriaLabel': 'Block nach oben',
  'document.block.moveDownAriaLabel': 'Block nach unten',
  'document.block.removeAriaLabel': 'Block entfernen',
  'document.block.imageEmpty': 'Noch kein Bild',
  'document.block.imageHeightAriaLabel': 'Bildhöhe',
  'document.block.alignLabel': 'Ausrichtung',
  'document.block.captionPlaceholder': 'Bildunterschrift',
  'document.block.chartSelectAriaLabel': 'Diagramm aus einem Dashboard',
  'document.block.chartReplaceOption': '{title} — ersetzen mit…',
  'document.block.chartSnapshotLabel': '3D-Schnappschuss',
  'document.block.topicSourceLabel': 'Thema',
  'document.block.topicNotLoaded': '{guid} (nicht geladen)',
  'document.block.pickTopicOption': 'Thema wählen…',
  'document.block.topicSnapshotLabel': 'Ansichtspunkt-Schnappschuss',
  'document.block.kindTable': 'Tabelle',
  'document.block.tableReplaceOption': '{name} — ersetzen mit…',
  'document.block.tableEditInLists': 'In Listen bearbeiten',
  'document.block.tableRowsLabel': 'Zeilen',
  'document.block.tableSummary': '{columns} Spalten · {view}',
  'document.block.tableViewFlat': 'eine Zeile je Element',
  'document.block.kindIdsReport': 'IDS-Bericht',
  'document.block.idsReportSourceLabel': 'Quelle',
  'document.block.idsReportRefresh': 'Vom aktuellen Prüfbericht aktualisieren',
  'document.block.idsReportRefreshDisabledTitle': 'Zuerst eine IDS-Prüfung ausführen',
};

afterEach(() => {
  cleanup();
  setLocale('en');
});

describe('BlockEditor localization (#4918)', () => {
  it('translates the text block: kind badge, style/insert-field controls, and move/remove buttons', () => {
    const block: TextBlock = { kind: 'text', id: 'b1', text: '', style: 'body' };
    const ui = render(
      <BlockEditor block={block} index={0} count={2} bindings={BINDINGS} topics={new Map()} charts={[]} idsValidationReport={null} onChange={noop} onMove={noop} onRemove={noop} />,
    );
    assert.equal(ui.querySelector('[data-block-editor]')?.textContent?.includes('Text'), true, 'the English kind badge is visible first');
    assert.ok(ui.querySelector('button[aria-label="Move block up"]'));
    assert.ok(ui.querySelector('button[aria-label="Move block down"]'));
    assert.ok(ui.querySelector('button[aria-label="Remove block"]'));
    assert.ok(ui.querySelector('select[aria-label="Text style"]'));
    assert.equal(ui.querySelector('select[aria-label="Insert field"]')?.getAttribute('title'), 'Insert a {path} that reads the model');

    registerLocale('block-editor-x', TEST_LOCALE);
    act(() => setLocale('block-editor-x'));

    assert.equal(ui.querySelector('[data-block-editor]')?.textContent?.includes('Texte'), true);
    assert.ok(ui.querySelector('button[aria-label="Block nach oben"]'));
    assert.ok(ui.querySelector('button[aria-label="Block nach unten"]'));
    assert.ok(ui.querySelector('button[aria-label="Block entfernen"]'));
    assert.ok(ui.querySelector('select[aria-label="Textstil"]'));
    assert.equal(ui.textContent?.includes('Feld einfügen'), true);
  });

  it('translates the image block: empty state, height/align/caption fields', () => {
    const block: ImageBlock = { kind: 'image', id: 'b2', dataUrl: '', height: 60, align: 'left' };
    const ui = render(
      <BlockEditor block={block} index={0} count={1} bindings={BINDINGS} topics={new Map()} charts={[]} idsValidationReport={null} onChange={noop} onMove={noop} onRemove={noop} />,
    );
    assert.equal(ui.textContent?.includes('No image yet'), true);
    assert.ok(ui.querySelector('input[aria-label="Image height"]'));
    assert.equal(ui.querySelector('input[placeholder="Caption"]') !== null, true);

    registerLocale('block-editor-x-image', TEST_LOCALE);
    act(() => setLocale('block-editor-x-image'));

    assert.equal(ui.querySelector('[data-block-editor]')?.textContent?.includes('Image_DE'), true, 'the kind badge switches with the locale');
    assert.equal(ui.textContent?.includes('Noch kein Bild'), true);
    assert.ok(ui.querySelector('input[aria-label="Bildhöhe"]'));
    assert.equal(ui.textContent?.includes('Ausrichtung'), true);
    assert.equal(ui.querySelector('input[placeholder="Bildunterschrift"]') !== null, true);
  });

  it('translates the chart block: kind label, the replace-with option (keeping the chart\'s own title as data), and the snapshot toggle', () => {
    const block: ChartBlock = { kind: 'chart', id: 'b3', chart: { id: 'c1', title: 'Costs by storey' } as unknown as ChartSpec, snapshot: false };
    const charts = [{ dashboard: 'Dash', chart: { id: 'c2', title: 'Other chart' } as unknown as ChartSpec }];
    const ui = render(
      <BlockEditor block={block} index={0} count={1} bindings={BINDINGS} topics={new Map()} charts={charts} idsValidationReport={null} onChange={noop} onMove={noop} onRemove={noop} />,
    );
    assert.equal(ui.textContent?.includes('Costs by storey — replace with…'), true, 'the chart\'s own title is model content, not translated');
    assert.equal(ui.textContent?.includes('3D snapshot'), true);

    registerLocale('block-editor-x-chart', TEST_LOCALE);
    act(() => setLocale('block-editor-x-chart'));

    assert.equal(ui.querySelector('[data-block-editor]')?.textContent?.includes('Diagramm'), true);
    assert.equal(ui.textContent?.includes('Costs by storey — ersetzen mit…'), true, 'the chart title stays literal inside the translated template');
    assert.equal(ui.textContent?.includes('3D-Schnappschuss'), true);
  });

  it('translates the topic block: kind label, the not-loaded/pick-a-topic interpolation, and the snapshot toggle', () => {
    const block: TopicBlock = { kind: 'topic', id: 'b4', guid: 'guid-123', snapshot: true };
    const ui = render(
      <BlockEditor block={block} index={0} count={1} bindings={BINDINGS} topics={new Map<string, BCFTopic>()} charts={[]} idsValidationReport={null} onChange={noop} onMove={noop} onRemove={noop} />,
    );
    assert.equal(ui.textContent?.includes('guid-123 (not loaded)'), true);
    assert.equal(ui.textContent?.includes('Viewpoint snapshot'), true);

    registerLocale('block-editor-x-topic', TEST_LOCALE);
    act(() => setLocale('block-editor-x-topic'));

    assert.equal(ui.querySelector('[data-block-editor]')?.textContent?.includes('BCF-Thema'), true);
    assert.equal(ui.textContent?.includes('Thema'), true);
    assert.equal(ui.textContent?.includes('guid-123 (nicht geladen)'), true, 'the guid is kept verbatim inside the translated template');
    assert.equal(ui.textContent?.includes('Ansichtspunkt-Schnappschuss'), true);
  });

  it('translates the table block (#5142): kind badge, the replace-with option keeping the list name, the rows label and the summary', () => {
    const list = { ...LIST_PRESETS[0], id: 'copy-1' };
    const block: TableBlock = { kind: 'table', id: 'b6', source: { kind: 'list', list, fromListId: LIST_PRESETS[0].id } };
    const ui = render(
      <BlockEditor block={block} index={0} count={1} bindings={BINDINGS} topics={new Map()} charts={[]} idsValidationReport={null} onChange={noop} onMove={noop} onRemove={noop} />,
    );
    assert.equal(ui.textContent?.includes(`${list.name} — replace with…`), true, 'the list name is model content, not translated');
    assert.equal(ui.textContent?.includes('Edit in Lists'), true);
    assert.equal(ui.textContent?.includes(`${list.columns.length} columns · one row per element`), true);

    registerLocale('block-editor-x-table', TEST_LOCALE);
    act(() => setLocale('block-editor-x-table'));

    assert.equal(ui.querySelector('[data-block-editor]')?.textContent?.includes('Tabelle'), true);
    assert.equal(ui.textContent?.includes(`${list.name} — ersetzen mit…`), true, 'the list name stays literal inside the translated template');
    assert.equal(ui.textContent?.includes('In Listen bearbeiten'), true);
    assert.equal(ui.textContent?.includes('Zeilen'), true);
    assert.equal(ui.textContent?.includes(`${list.columns.length} Spalten · eine Zeile je Element`), true);
  });

  it('translates the IDS report block (#5125): kind badge, source label, and the refresh button — no report loaded so it is disabled', () => {
    const block: IdsReportBlock = {
      kind: 'ids-report', id: 'b7', sourceName: 'Fire safety IDS', generatedAt: '2026-01-01T00:00:00Z',
      summary: { checked: 4, passed: 3, failed: 1, passRate: 75 },
      checks: [{ id: 's1', shortDescription: 'Walls have a fire rating', checked: 4, passed: 3, failed: 1, passRate: 75 }],
    };
    const ui = render(
      <BlockEditor block={block} index={0} count={1} bindings={BINDINGS} topics={new Map()} charts={[]} idsValidationReport={null} onChange={noop} onMove={noop} onRemove={noop} />,
    );
    assert.equal(ui.querySelector('[data-block-editor]')?.textContent?.includes('IDS report'), true);
    assert.equal(ui.textContent?.includes('Fire safety IDS'), true, 'the report source name is model content, not translated');
    const refreshButton = [...ui.querySelectorAll('button')].find((b) => b.textContent?.includes('Refresh from current validation report'));
    assert.ok(refreshButton, 'the refresh button is present');
    assert.equal(refreshButton?.hasAttribute('disabled'), true, 'no live report is loaded');

    registerLocale('block-editor-x-ids-report', TEST_LOCALE);
    act(() => setLocale('block-editor-x-ids-report'));

    assert.equal(ui.querySelector('[data-block-editor]')?.textContent?.includes('IDS-Bericht'), true);
    assert.equal(ui.textContent?.includes('Quelle'), true);
    assert.equal(ui.textContent?.includes('Vom aktuellen Prüfbericht aktualisieren'), true);
  });

  it('translates the spacer block\'s kind badge', () => {
    const block: SpacerBlock = { kind: 'spacer', id: 'b5', height: 20 };
    const ui = render(
      <BlockEditor block={block} index={0} count={1} bindings={BINDINGS} topics={new Map()} charts={[]} idsValidationReport={null} onChange={noop} onMove={noop} onRemove={noop} />,
    );
    assert.equal(ui.querySelector('[data-block-editor]')?.textContent?.includes('Spacer'), true);

    registerLocale('block-editor-x-spacer', TEST_LOCALE);
    act(() => setLocale('block-editor-x-spacer'));
    assert.equal(ui.querySelector('[data-block-editor]')?.textContent?.includes('Abstand'), true);
  });
});
