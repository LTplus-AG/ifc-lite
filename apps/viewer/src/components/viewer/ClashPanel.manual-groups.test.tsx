/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { summarizeClashes, type Clash, type ClashResult } from '@ifc-lite/clash';
import { createBCFProject, createBCFTopic } from '@ifc-lite/bcf';
import type { IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { MANUAL_CLASH_GROUPS_KEY } from '@/lib/clash/manual-groups';
import { ClashPanel } from './ClashPanel.js';

Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 800 });
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 600 });

function clash(id: string, a: number, b: number): Clash {
  return {
    id,
    a: { key: `${id}-wall`, ref: a, model: 'model', tag: 'IfcWall', name: `${id} wall` },
    b: { key: `${id}-pipe`, ref: b, model: 'model', tag: 'IfcPipeSegment', name: `${id} pipe` },
    rule: 'coordination', status: 'hard', distance: -0.1, point: [0, 0, 0],
    bounds: { min: [0, 0, 0], max: [1, 1, 1] }, severity: 'major',
  };
}

function result(): ClashResult {
  const clashes = [clash('c1', 1, 2), clash('c2', 3, 4)];
  return {
    clashes,
    summary: summarizeClashes(clashes),
    rulesRun: [{ id: 'coordination', name: 'Coordination', a: 'IfcWall', b: 'IfcPipeSegment', mode: 'hard' }],
    settings: { tolerance: 0.002, excludeVoidsAndHosts: true },
  };
}

let root: Root | null = null;
let container: HTMLElement | null = null;

function buttonWithText(text: string): HTMLButtonElement {
  const button = [...document.body.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === text);
  assert.ok(button instanceof HTMLButtonElement, `button "${text}" must render`);
  return button;
}

async function setDialogName(value: string): Promise<void> {
  const input = document.body.querySelector('input[maxlength="100"]');
  assert.ok(input instanceof HTMLInputElement, 'group-name input must render in the dialog portal');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  assert.ok(setter, 'native input value setter must exist');
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(async () => {
  localStorage.removeItem(MANUAL_CLASH_GROUPS_KEY);
  useViewerStore.setState({
    clashResult: result(),
    clashGroups: [],
    clashSelectedId: null,
    clashSortBy: 'severity',
    clashHideTouching: false,
    clashReviews: new Map(),
    clashStatusFilter: new Set(['open', 'resolved', 'accepted']),
    bcfProject: null,
    cameraCallbacks: {},
    fromGlobalId: (expressId: number) => ({ modelId: 'model', expressId }),
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<ClashPanel />));
});

afterEach(async () => {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  container?.remove();
  container = null;
  localStorage.removeItem(MANUAL_CLASH_GROUPS_KEY);
  useViewerStore.setState({ clashResult: null, clashGroups: null, bcfProject: null });
});

describe('ClashPanel manual groups (#4921)', () => {
  it('creates, renames, edits, and ungroups a persisted expandable group', async () => {
    const checkboxes = [...container!.querySelectorAll('input[type="checkbox"]')]
      .filter((input) => input.getAttribute('aria-label')?.startsWith('Select clash '));
    assert.equal(checkboxes.length, 2, 'each pair row must offer grouping selection');
    await act(async () => {
      for (const checkbox of checkboxes) (checkbox as HTMLInputElement).click();
    });

    await act(async () => buttonWithText('Group selected (2)').click());
    await setDialogName('Riser coordination');
    await act(async () => buttonWithText('Create group').click());

    assert.ok(container!.querySelector('button[aria-label="Collapse Riser coordination"]'));
    const stored = JSON.parse(localStorage.getItem(MANUAL_CLASH_GROUPS_KEY) ?? 'null') as { groups: Array<{ name: string; members: unknown[] }> };
    assert.equal(stored.groups[0].name, 'Riser coordination');
    assert.equal(stored.groups[0].members.length, 2);

    await act(async () => {
      useViewerStore.setState({
        ifcDataStore: {
          entities: { getGlobalId: (id: number) => id === 99 ? 'HIDDEN0000000000000001' : undefined },
        } as unknown as IfcDataStore,
        hiddenEntities: new Set([99]),
      });
    });

    const createBcf = container!.querySelector('button[title="Create one BCF topic from this group"]');
    assert.ok(createBcf instanceof HTMLButtonElement);
    const concurrentProject = createBCFProject({ name: 'Concurrent review' });
    const concurrentTopic = createBCFTopic({
      title: 'Created during capture',
      author: 'reviewer@example.invalid',
    });
    concurrentProject.topics.set(concurrentTopic.guid, concurrentTopic);
    let finishFraming!: () => void;
    useViewerStore.setState({
      cameraCallbacks: {
        frameSelection: () => new Promise<void>((resolve) => { finishFraming = resolve; }),
      },
    });
    await act(async () => {
      createBcf.click();
      useViewerStore.setState({ bcfProject: concurrentProject });
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      assert.equal(useViewerStore.getState().bcfProject?.topics.size, 1,
        'capture must not commit a topic at an intermediate animated camera pose');
      finishFraming();
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
    const topics = useViewerStore.getState().bcfProject?.topics;
    assert.equal(topics?.size, 2, 'a project created during capture is preserved when the group topic commits');
    assert.ok(topics?.has(concurrentTopic.guid), 'the concurrent topic is not overwritten by stale project state');
    const groupTopic = [...topics!.values()].find((topic) => topic.title === 'Riser coordination');
    assert.ok(groupTopic, 'one group action creates its BCF topic');
    assert.deepEqual(
      groupTopic.header?.map((file) => file.filename),
      ['model.ifc'],
      'a pre-existing hidden component from another source must remain in the topic header',
    );

    const rename = container!.querySelector('button[title="Rename this group"]');
    assert.ok(rename instanceof HTMLButtonElement);
    await act(async () => rename.click());
    await setDialogName('Level 2 riser');
    await act(async () => buttonWithText('Save name').click());
    assert.ok(container!.querySelector('button[aria-label="Collapse Level 2 riser"]'));

    const removeMember = container!.querySelector('button[title="Remove this clash from the group"]');
    assert.ok(removeMember instanceof HTMLButtonElement);
    await act(async () => removeMember.click());
    const afterEdit = JSON.parse(localStorage.getItem(MANUAL_CLASH_GROUPS_KEY) ?? 'null') as { groups: Array<{ members: unknown[] }> };
    assert.equal(afterEdit.groups[0].members.length, 1, 'editing membership keeps the surviving pair');

    const ungroup = container!.querySelector('button[title="Ungroup these clashes"]');
    assert.ok(ungroup instanceof HTMLButtonElement);
    await act(async () => ungroup.click());
    assert.equal(container!.querySelector('button[aria-label="Collapse Level 2 riser"]'), null);
    const afterUngroup = JSON.parse(localStorage.getItem(MANUAL_CLASH_GROUPS_KEY) ?? 'null') as { groups: unknown[] };
    assert.deepEqual(afterUngroup.groups, []);
  });
});
