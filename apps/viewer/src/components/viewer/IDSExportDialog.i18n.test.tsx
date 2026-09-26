/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `IDSExportDialog` localization (#4918 slice extending `ids-panel.en.ts`
 * from #5030 to this dialog). Same pseudo-locale oracle shape as
 * `IDSPanel.i18n.test.tsx` and `IDSCorrectionDialog.i18n.test.tsx`.
 *
 * Also covers the raw-count plural for the "N failing entities found"
 * clause and the progress-dependent Cancel/Close/Exporting… labels, since
 * those branch on props rather than always rendering.
 */
import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import { idsPanelEn } from '@/i18n/catalogues/ids-panel.en';
import { IDSExportDialog, type IDSExportProgress } from './IDSExportDialog.js';

type IdsPanelKey = keyof typeof idsPanelEn;
const mark = (key: IdsPanelKey) => `⟦${key}⟧`;

function pseudoCatalogue(): Catalogue {
  return Object.fromEntries(
    (Object.keys(idsPanelEn) as IdsPanelKey[]).map((key) => [key, mark(key)]),
  );
}

function bodyText(): string {
  return document.body.textContent ?? '';
}

afterEach(() => {
  cleanup();
  setLocale('en');
});

describe('IDSExportDialog localization (#4918)', () => {
  it('renders the English dialog chrome with no failures and no progress', () => {
    render(
      <IDSExportDialog
        open
        onOpenChange={() => {}}
        hasReport={false}
        failedCount={0}
        onExport={async () => {}}
        progress={null}
      />,
    );
    const text = bodyText();
    assert.match(text, /Export IDS Report as BCF/);
    assert.match(text, /Create BCF topics from IDS validation failures\./);
    assert.doesNotMatch(text, /failing entit(y|ies) found/, 'no failing-entities-found clause when failedCount is 0');
    assert.match(text, /Topic Grouping/);
    // Per specification is the default since #5824 (per entity scales with the model).
    assert.match(text, /Per Specification \(recommended\)/);
    assert.match(text, /One topic per failing specification\. Entities listed as comments\./);
    assert.match(text, /Include Passing Entities/);
    assert.match(text, /Add topics for entities that passed validation/);
    assert.match(text, /Per-Entity Camera/);
    assert.match(text, /Compute camera framing each entity from its bounding box/);
    assert.match(text, /Capture Snapshots/);
    assert.match(text, /Render a screenshot for each entity \(slow for large reports\)/);
    assert.match(text, /Load into BCF Panel/);
    assert.match(text, /Open the BCF panel with exported topics after export/);
    assert.match(text, /Cancel/);
    assert.match(text, /Export BCF/);
  });

  it('pluralizes the failing-entities count and switches Cancel/Close/Exporting by progress phase', () => {
    render(
      <IDSExportDialog
        open
        onOpenChange={() => {}}
        hasReport
        failedCount={3}
        onExport={async () => {}}
        progress={null}
      />,
    );
    assert.match(bodyText(), /3 failing entities found\./);
    cleanup();

    const exportingProgress: IDSExportProgress = { phase: 'building', current: 1, total: 4, message: 'Building topics' };
    render(
      <IDSExportDialog
        open
        onOpenChange={() => {}}
        hasReport
        failedCount={1}
        onExport={async () => {}}
        progress={exportingProgress}
      />,
    );
    const exportingText = bodyText();
    assert.match(exportingText, /1 failing entity found\./);
    assert.match(exportingText, /Exporting…/);
    assert.doesNotMatch(exportingText, /Export BCF/, 'the export button swaps to the exporting label while in progress');
    cleanup();

    const doneProgress: IDSExportProgress = { phase: 'done', current: 4, total: 4, message: 'Done' };
    render(
      <IDSExportDialog
        open
        onOpenChange={() => {}}
        hasReport
        failedCount={0}
        onExport={async () => {}}
        progress={doneProgress}
      />,
    );
    const doneText = bodyText();
    assert.match(doneText, /Close/);
    assert.doesNotMatch(doneText, /Cancel/);
  });

  it('retranslates the dialog chrome from the active pseudo-locale', () => {
    registerLocale('en-x-ids-export-pseudo', pseudoCatalogue());
    render(
      <IDSExportDialog
        open
        onOpenChange={() => {}}
        hasReport={false}
        failedCount={2}
        onExport={async () => {}}
        progress={null}
      />,
    );
    act(() => setLocale('en-x-ids-export-pseudo'));
    const text = bodyText();
    assert.match(text, /⟦idsPanel\.export\.title⟧/);
    assert.match(text, /⟦idsPanel\.export\.description⟧/);
    assert.match(text, /⟦idsPanel\.export\.topicGrouping⟧/);
    assert.match(text, /⟦idsPanel\.export\.grouping\.perSpecification⟧/);
    assert.match(text, /⟦idsPanel\.export\.includePassing⟧/);
    assert.match(text, /⟦idsPanel\.export\.perEntityCamera⟧/);
    assert.match(text, /⟦idsPanel\.export\.captureSnapshots⟧/);
    assert.match(text, /⟦idsPanel\.export\.loadIntoPanel⟧/);
    assert.match(text, /⟦idsPanel\.export\.cancel⟧/);
    assert.match(text, /⟦idsPanel\.export\.exportBcf⟧/);
    assert.doesNotMatch(text, /Export IDS Report as BCF/, 'English literal must not survive a locale switch');
  });
});
