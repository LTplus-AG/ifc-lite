/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Rename, save and merge rows keep a usable control at the side panel's real
 * widths (#11439). Each row put a `min-w-0 flex-1` input or select beside
 * fixed-width buttons in a row that could not wrap, so a narrow panel squeezed
 * the control to a stub or pushed the row past the panel edge.
 *
 * The component is mounted for real (happy-dom), then its markup is laid out
 * in real Chrome with the compiled app stylesheet inside a panel-width box, as
 * in `LibraryPicker.layout.test.tsx`. Only numbers leave the page.
 */

import '@/test/setup-dom.js';
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { registerLocale, setLocale } from '@/i18n';
import { clashGroupApplyDe } from '@/i18n/locales/de/clash-group-apply';
import { chatDe } from '@/i18n/locales/de/chat';
import { comparePanelDe } from '@/i18n/locales/de/compare-panel';
import { cleanup, click, render } from '@/test/render.js';
import { CONTRAST_BROWSER_SKIP, closeContrastBrowser, warmContrastBrowser, withThemedPage } from '@/test/contrast/render-harness.js';
import { draftFromGroups, type DraftFinding } from '@/lib/assistant/clash-group-draft';
import { ClashGroupDraftEditor } from './ClashGroupDraftEditor.js';
import { ConversationLibrary } from './ConversationLibrary.js';
import { SavedComparisonLibrary } from '../compare/SavedComparisonLibrary.js';

/** The floating panel's minimum and the docked panel's default. */
const PANEL_WIDTHS = [260, 350] as const;
/** The `min-w-[8rem]` floor: a control narrower than this is a stub. */
const MIN_CONTROL_PX = 128;

before(warmContrastBrowser);
afterEach(() => { cleanup(); setLocale('en'); });
after(closeContrastBrowser);

function finding(occurrence: string): DraftFinding {
  return { citation: occurrence, occurrence, nativeType: 'hard', nativeSeverity: 'major',
    disciplineCandidates: { a: ['ARC'], b: ['MEP'] } } as DraftFinding;
}

/** Markup as mounted, after `interact` (a click into rename mode). */
function htmlOf(element: React.ReactElement, interact: (ui: HTMLElement) => void = () => {}): string {
  const ui = render(element);
  interact(ui);
  const html = ui.innerHTML;
  cleanup();
  return html;
}

/** The clash editor with its first group header in rename mode, and both groups' merge rows. */
function clashEditorHtml(): string {
  const draft = draftFromGroups([
    { name: 'Walls vs pipes', explanation: '', findings: [finding('o1')] },
    { name: 'Riser', explanation: '', findings: [finding('o2')] },
  ], 2, { kind: 'sample', evidenceId: 'e', omittedFromEvidence: 0 });
  // The header's first button is the rename pencil, in any locale.
  return htmlOf(<ClashGroupDraftEditor draft={draft} onChange={() => {}} resolve={() => undefined}
    focusClash={() => {}} focusClashes={() => {}} />, (ui) => click(ui.querySelector<HTMLButtonElement>('h4 button')!));
}

interface RowLayout { control: number; overflow: number }

/** Width of each matched control, and how far its row reaches past the panel's right edge. */
async function layoutAt(html: string, width: number, selector: string): Promise<RowLayout[]> {
  return withThemedPage('light', `<div id="panel" class="bg-card text-xs" style="width:${width}px">${html}</div>`, async (page) => {
    await page.evaluate('globalThis.__name = (fn) => fn;');
    return page.evaluate((query) => {
      const panel = document.getElementById('panel')!.getBoundingClientRect();
      return [...document.querySelectorAll<HTMLElement>(`#panel ${query}`)].map((control) => {
        const row = control.parentElement!;
        const reach = Math.max(...[...row.children].map((child) => child.getBoundingClientRect().right));
        return { control: Math.round(control.getBoundingClientRect().width), overflow: Math.round(reach - panel.right) };
      });
    }, selector);
  });
}

const ROWS = [
  { name: 'clash group rename and merge', html: clashEditorHtml, selector: 'form > input, div > select', count: 3 },
  { name: 'saved conversation name', html: () => htmlOf(<ConversationLibrary />), selector: '#assistant-conversation-name', count: 1 },
  { name: 'saved comparison name', html: () => htmlOf(<SavedComparisonLibrary result={null} running={false} />),
    selector: '[data-saved-comparisons] > div.flex > input', count: 1 },
] as const;

describe('narrow side-panel rows keep a usable control (#11439)', () => {
  for (const locale of ['en', 'de'] as const) {
    for (const row of ROWS) {
      it(`${row.name} (${locale})`, { skip: CONTRAST_BROWSER_SKIP }, async () => {
        if (locale === 'de') {
          registerLocale('de', { ...clashGroupApplyDe, ...chatDe, ...comparePanelDe });
          setLocale('de');
        }
        const html = row.html();
        for (const width of PANEL_WIDTHS) {
          const layouts = await layoutAt(html, width, row.selector);
          assert.equal(layouts.length, row.count, `${row.name} renders its control at ${width}px`);
          for (const layout of layouts) {
            assert.ok(layout.control >= MIN_CONTROL_PX, `${row.name} control at ${width}px is ${layout.control}px`);
            assert.ok(layout.overflow <= 0, `${row.name} at ${width}px reaches ${layout.overflow}px past the panel`);
          }
        }
      });
    }
  }
});
