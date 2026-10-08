/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Every export the shared dialog shell runs appears in the activity tray
 * (U02, #6925) with the dialog's own outcome: running while it exports,
 * completed or failed with the dialog's message after. A `null` outcome is a
 * hand-off whose host reports elsewhere, so the tray does not guess one.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, click, render } from '@/test/render.js';
import { useActivityJournal } from '@/lib/activity/activity-journal';
import { ExportDialogShell, type ExportDialogShellResult } from './ExportDialogShell.js';

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  useActivityJournal.setState({ jobs: [] });
});

function mount(onExport: () => Promise<ExportDialogShellResult | null>): void {
  render(
    <ExportDialogShell trigger={<button>Open export dialog</button>} icon={<span>icon</span>} title="Export IFC"
      description="A description" cancelLabel="Cancel" exportLabel="Export" exportingLabel="Exporting..." onExport={onExport}>
      <div>options</div>
    </ExportDialogShell>,
  );
  click([...document.body.querySelectorAll('button')].find((b) => b.textContent === 'Open export dialog')!);
}

async function exportNow(): Promise<void> {
  await act(async () => {
    [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Export')!.click();
  });
}

describe('export jobs in the activity tray (U02, #6925)', () => {
  it('records the export while it runs and its success after', async () => {
    let finish: (result: ExportDialogShellResult) => void = () => {};
    mount(() => new Promise((resolve) => { finish = resolve; }));
    await exportNow();
    const [running] = useActivityJournal.getState().jobs;
    assert.deepEqual([running.kind, running.subject, running.outcome], ['export', 'Export IFC', 'running']);
    await act(async () => { finish({ success: true, message: 'Saved' }); });
    assert.equal(useActivityJournal.getState().jobs[0].outcome, 'completed');
  });

  it('a failed export is failed with the dialog message', async () => {
    mount(async () => ({ success: false, message: 'Disk full' }));
    await exportNow();
    const [job] = useActivityJournal.getState().jobs;
    assert.deepEqual([job.outcome, job.detail], ['failed', 'Disk full']);
  });

  it('a hand-off (null) leaves no job behind', async () => {
    mount(async () => null);
    await exportNow();
    assert.equal(useActivityJournal.getState().jobs.length, 0);
  });
});
