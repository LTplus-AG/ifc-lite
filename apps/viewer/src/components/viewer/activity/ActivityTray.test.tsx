/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one activity tray (U02, #6925), mounted from its status-bar button:
 * session jobs and durable BCF publications in one list, running first; each
 * row states what ran and on what, its outcome in words, Cancel only where the source
 * can cancel, and Open for the panel that owns the job's artifact. Durable
 * publication outcomes come from the outbox record as stored.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { advance, cleanup, click, press, render } from '@/test/render.js';
import type { BimContext } from '@ifc-lite/sdk';
import { BimReactContext } from '@/sdk/BimProvider';
import { MobileToolbar } from '../MobileToolbar';
import { beginActivity, finishActivity, restoreActivityJournal, useActivityJournal } from '@/lib/activity/activity-journal';
import { isCataloguedKey } from '@/lib/activity/activity-recorders';
import { useBcfOutbox } from '@/lib/bcf-publication/outbox-store';
import type { BcfPublication, OutboxState } from '@/lib/bcf-publication/outbox-types';
import { publicationActivity } from '@/lib/activity/publication-activity';
import { ActivityTrayButton } from './ActivityTray';

const initial = useViewerStore.getState();
const T0 = 1_760_000_000_000;

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  useActivityJournal.setState({ jobs: [] });
  useBcfOutbox.setState({ entries: [] });
  useViewerStore.setState(initial, true);
});

function publication(id: string, states: OutboxState[], updatedAt = '2025-10-09T10:00:00.000Z'): BcfPublication {
  return {
    version: 1, id, origin: 'draft', batchName: `Batch ${id}`, createdAt: updatedAt, updatedAt,
    target: { serverUrl: 'https://bcf.example', projectId: 'p1', projectName: 'Project', userId: 'u1' },
    entries: states.map((state, index) => ({
      id: `${id}-${index}`, operation: 'createTopic', topicGuid: `t${index}`, payload: {}, digest: `d${index}`,
      state, attempts: 0, queuedAt: updatedAt,
    })),
  };
}

const text = (root: ParentNode) => root.textContent?.replace(/\s+/g, ' ') ?? '';
const rows = () => [...document.body.querySelectorAll('ul[aria-label="Jobs"] > li')];

describe('publication outcome (U02, #6925)', () => {
  it('an unknown server effect outranks failure and success; never reads as completed', () => {
    const outcome = (states: OutboxState[]) => publicationActivity(publication('x', states)).outcome;
    assert.equal(outcome(['done', 'sending']), 'running');
    assert.equal(outcome(['done', 'uncertain', 'failed']), 'uncertain');
    assert.equal(outcome(['done', 'blocked']), 'blocked');
    assert.equal(outcome(['done', 'queued']), 'queued');
    assert.equal(outcome(['done', 'failed']), 'partial');
    assert.equal(outcome(['failed', 'failed']), 'failed');
    assert.equal(outcome(['done', 'done']), 'completed');
  });
});

describe('activity tray (U02, #6925)', () => {
  it('lists running jobs first, with outcomes in words and only real actions', () => {
    let flowCancels = 0;
    const exportJob = beginActivity({ kind: 'export', title: 'activityTray.job.export', subject: 'Export IFC' }, T0);
    finishActivity(exportJob, 'failed', { detail: 'Disk full' }, T0 + 1);
    beginActivity({ kind: 'flow', title: 'activityTray.job.flow', subject: 'Door check', panel: 'flow', cancel: () => { flowCancels++; } }, T0 + 2);
    useBcfOutbox.setState({ entries: [publication('b1', ['done', 'uncertain'])] });

    const ui = render(<ActivityTrayButton />);
    const trigger = ui.querySelector('button')!;
    assert.equal(trigger.getAttribute('aria-label'), 'Activity: 1 job running');
    click(trigger);

    const [flow, publicationRow, exported] = rows();
    assert.match(text(flow), /Flow run.*Door check.*Running/);
    assert.match(text(publicationRow), /BCF publication.*Batch b1.*Outcome unknown.*1 of 2 server effects done.*Kept across reloads.*1 effect needs a server check/);
    assert.match(text(exported), /Export.*Export IFC.*Failed.*Disk full/);

    assert.equal(exported.querySelector('button[aria-label^="Cancel"]'), null, 'a finished job offers no Cancel');
    assert.equal(publicationRow.querySelector('button[aria-label^="Cancel"]'), null, 'a durable outbox entry is not cancelled from here');
    click(flow.querySelector('button[aria-label="Cancel Flow run"]')!);
    assert.equal(flowCancels, 1);
  });

  it('Open shows the panel that owns the job and closes the tray', () => {
    const opened: string[] = [];
    useViewerStore.setState({ openWorkspacePanel: (panel) => { opened.push(panel); } });
    const id = beginActivity({ kind: 'check', title: 'activityTray.job.clash', panel: 'clash' }, T0);
    finishActivity(id, 'completed', {}, T0 + 1);
    const ui = render(<ActivityTrayButton />);
    click(ui.querySelector('button')!);
    click(document.body.querySelector('button[aria-label="Open Clash detection"]')!);
    assert.deepEqual(opened, ['clash']);
    assert.equal(rows().length, 0, 'the tray closed');
  });

  it('a job cut off by a reload shows as interrupted with no Cancel', () => {
    beginActivity({ kind: 'check', title: 'activityTray.job.validation', panel: 'validation', cancel: () => {} }, T0);
    useActivityJournal.setState({ jobs: [] }); // the page went away
    restoreActivityJournal(isCataloguedKey);
    const ui = render(<ActivityTrayButton />);
    assert.equal(ui.querySelector('button')!.getAttribute('aria-label'), 'Activity', 'nothing is running any more');
    click(ui.querySelector('button')!);
    const [row] = rows();
    assert.match(text(row), /Data validation.*Interrupted.*did not finish/);
    assert.equal(row.querySelector('button[aria-label^="Cancel"]'), null);
  });

  it('clears finished session jobs but keeps durable publications', async () => {
    beginActivity({ kind: 'export', title: 'activityTray.job.export' }, T0);
    finishActivity(useActivityJournal.getState().jobs[0].id, 'completed', {}, T0 + 1);
    useBcfOutbox.setState({ entries: [publication('b2', ['done'])] });
    const ui = render(<ActivityTrayButton />);
    click(ui.querySelector('button')!);
    assert.equal(rows().length, 2);
    await act(async () => {
      [...document.body.querySelectorAll('button')].find((button) => button.textContent === 'Clear finished')!.click();
    });
    assert.deepEqual(rows().map((row) => /BCF publication/.test(text(row))), [true]);
  });

  it('says so when nothing has run', () => {
    const ui = render(<ActivityTrayButton />);
    click(ui.querySelector('button')!);
    assert.match(text(document.body), /No jobs in this session yet\./);
  });
});

describe('activity tray on phones (U02, #6925)', () => {
  it('the overflow menu opens the same jobs in a dialog, since phones show no status bar', async () => {
    beginActivity({ kind: 'flow', title: 'activityTray.job.flow', subject: 'Door check', panel: 'flow', cancel: () => {} }, T0);
    render(<BimReactContext.Provider value={{} as BimContext}><MobileToolbar /></BimReactContext.Provider>);
    press(document.querySelector<HTMLElement>('[aria-label="More actions"]')!, 'ArrowDown');
    await advance(10);
    const item = document.querySelector<HTMLElement>('[data-command-id="ui:activity"]');
    assert.ok(item);
    assert.equal(text(item).trim(), 'Activity');
    click(item);
    await advance(20);
    const dialog = document.querySelector('[role="dialog"]');
    assert.ok(dialog, 'the tray opens as a dialog');
    assert.equal(dialog.getAttribute('aria-labelledby') && document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent, 'Activity');
    assert.match(text(dialog), /Flow run.*Door check.*Running/);
  });
});
