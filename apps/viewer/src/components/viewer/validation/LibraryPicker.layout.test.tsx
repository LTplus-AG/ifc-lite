/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The validation library pickers keep their whole label and a usable select
 * at the side panel's real widths (#8802 "Select IDS document" clips).
 *
 * The toolbar is mounted for real (happy-dom), then its markup is laid out in
 * real Chrome with the compiled app stylesheet, inside a panel-width box. When
 * the label shared a wrapping row with the four or five library actions, they
 * squeezed it to about 45 px: "Select IDS document" broke over three lines and
 * clipped to "documer", and the select shrank to a stub. The IDS, rule-set and
 * manual-checklist toolbars all lay out through `LibraryPicker`; the manual
 * checklist library had the same squeezed row (PR 9286 review).
 *
 * Only numbers and booleans leave the page, never an element.
 */

import '@/test/setup-dom.js';
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseIDS } from '@ifc-lite/ids';
import { parseRuleSetFile } from '@ifc-lite/rules';
import { registerLocale, setLocale } from '@/i18n';
import { validationPanelDe } from '@/i18n/locales/de/validation-panel';
import { manualValidationDe } from '@/i18n/locales/de/manual-validation';
import { useViewerStore } from '@/store';
import { cleanup, render } from '@/test/render.js';
import { CONTRAST_BROWSER_SKIP, closeContrastBrowser, warmContrastBrowser, withThemedPage } from '@/test/contrast/render-harness.js';
import { DefinitionLibraryToolbar } from './DefinitionLibraryToolbar.js';
import { ManualChecklistLibrary } from './ManualChecklistLibrary.js';

/** The floating panel's minimum, the docked panel's default, and wider. */
const PANEL_WIDTHS = [260, 350, 480] as const;
/** The select spans at least this share of the toolbar's content box. */
const SELECT_MIN_SHARE = 0.9;

const initial = useViewerStore.getState();
const idsXml = readFileSync(new URL('../../../../public/samples/building-architecture.ids', import.meta.url), 'utf8');
const parsedRules = parseRuleSetFile({ version: 1, name: 'Delivery rules', rules: [] });
if (!parsedRules.ok) throw new Error(`rule set fixture rejected: ${parsedRules.error}`);
const rules = parsedRules.file;

before(warmContrastBrowser);
afterEach(() => {
  cleanup();
  setLocale('en');
  useViewerStore.setState(initial);
});
after(closeContrastBrowser);

function seedLibrary(): void {
  localStorage.clear();
  const store = useViewerStore.getState();
  store.addValidationDefinition({ kind: 'ids', xml: idsXml, document: parseIDS(idsXml) });
  store.addValidationDefinition({ kind: 'rules', file: rules });
  store.setManualChecklist({ version: 1, name: 'Site handover', groups: [{ id: 'g', name: 'Delivery', items: [{ id: 'q', text: 'Survey approved' }] }] });
}

type PickerKind = 'ids' | 'rules' | 'manual';
/** Each toolbar's actions with every optional one shown. */
const MIN_ACTIONS: Record<PickerKind, number> = { ids: 4, rules: 4, manual: 3 };

/** Markup of the toolbar as the panel mounts it, every action present. */
function toolbarHtml(kind: PickerKind): string {
  const ui = kind === 'ids'
    ? render(<DefinitionLibraryToolbar kind="ids" onImport={() => {}} />)
    : kind === 'rules'
      ? render(<DefinitionLibraryToolbar kind="rules" onNew={() => {}} onImportFile={async () => {}} />)
      : render(<ManualChecklistLibrary model={null} onNew={() => {}} onSelected={() => {}} active />);
  const html = ui.innerHTML;
  cleanup();
  return html;
}

interface PickerLayout {
  labelText: string;
  labelLines: number;
  labelClipped: boolean;
  selectWidth: number;
  contentWidth: number;
  buttonCount: number;
}

async function layoutAt(html: string, width: number): Promise<PickerLayout> {
  return withThemedPage('light', `<div id="panel" class="bg-card" style="width:${width}px">${html}</div>`, async (page) => {
    await page.evaluate('globalThis.__name = (fn) => fn;');
    return page.evaluate(() => {
      const select = document.querySelector('#panel select') as HTMLSelectElement;
      const label = select.closest('label') as HTMLLabelElement;
      const toolbar = document.querySelector('#panel > div') as HTMLElement;
      const text = [...label.childNodes].find((node) => node.nodeType === Node.TEXT_NODE)!;
      const range = document.createRange();
      range.selectNodeContents(text);
      const lines = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
      const labelBox = label.getBoundingClientRect();
      const textBox = range.getBoundingClientRect();
      const style = getComputedStyle(toolbar);
      return {
        labelText: text.textContent ?? '',
        labelLines: lines,
        labelClipped: textBox.right > labelBox.right + 0.5 || label.scrollWidth > label.clientWidth,
        selectWidth: Math.round(select.getBoundingClientRect().width),
        contentWidth: Math.round(toolbar.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)),
        buttonCount: document.querySelectorAll('#panel button').length,
      };
    });
  });
}

describe('validation library picker layout at side-panel widths (#8802)', () => {
  for (const locale of ['en', 'de'] as const) {
    for (const kind of ['ids', 'rules', 'manual'] as const) {
      it(`${kind} picker keeps its whole label and a full-width select (${locale})`, { skip: CONTRAST_BROWSER_SKIP }, async () => {
        if (locale === 'de') {
          registerLocale('de', { ...validationPanelDe, ...manualValidationDe });
          setLocale('de');
        }
        seedLibrary();
        const html = toolbarHtml(kind);
        for (const width of PANEL_WIDTHS) {
          const layout = await layoutAt(html, width);
          assert.ok(layout.buttonCount >= MIN_ACTIONS[kind], `${kind} at ${width}px renders its library actions (${layout.buttonCount})`);
          assert.equal(layout.labelLines, 1, `"${layout.labelText}" at ${width}px sits on one line, not ${layout.labelLines}`);
          assert.equal(layout.labelClipped, false, `"${layout.labelText}" at ${width}px is not clipped`);
          assert.ok(layout.selectWidth >= layout.contentWidth * SELECT_MIN_SHARE,
            `${kind} select at ${width}px is ${layout.selectWidth}px of a ${layout.contentWidth}px row`);
        }
      });
    }
  }
});
