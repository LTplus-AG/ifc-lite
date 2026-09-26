/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { clashReviewKey, summarizeClashes, type Clash, type ClashResult } from '@ifc-lite/clash';
import { createBCFProject, createBCFTopic } from '@ifc-lite/bcf';
import type { IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { MANUAL_CLASH_GROUPS_KEY } from '@/lib/clash/manual-groups';
import { ClashPanel } from './ClashPanel.js';
import { ClashManualGroupDialog } from './ClashManualGroupDialog.js';
import { Toaster } from '@/components/ui/toast.js';

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
    bcfPanelVisible: false,
    cameraCallbacks: {},
    fromGlobalId: (expressId: number) => ({ modelId: 'model', expressId }),
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<><ClashPanel /><Toaster /></>));
});

afterEach(async () => {
  const dismiss = container?.querySelector<HTMLButtonElement>('button[aria-label="Dismiss notification"]');
  if (dismiss) await act(async () => dismiss.click());
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  container?.remove();
  container = null;
  localStorage.removeItem(MANUAL_CLASH_GROUPS_KEY);
  useViewerStore.setState({ clashResult: null, clashGroups: null, bcfProject: null });
});

describe('ClashPanel manual groups (#4921, #5122)', () => {
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
      assert.equal(useViewerStore.getState().ghostExceptEntities, null,
        'BCF capture normalizes viewer-only ghosting to a reproducible colored presentation');
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
    assert.equal(useViewerStore.getState().bcfPanelVisible, false,
      'creating a group topic must leave the Clash workspace open (#5827)');
    assert.ok(container!.textContent?.includes('Topic created'), 'the group path shows its success toast');
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
    await act(async () => buttonWithText('Open BCF').click());
    assert.equal(useViewerStore.getState().bcfPanelVisible, true, 'the toast action opens BCF');
  });

  it('keeps the create dialog open when its persistence callback fails', async () => {
    let closeRequested = false;
    await act(async () => root!.render(
      <ClashManualGroupDialog
        open
        initialName="Retry this group"
        memberCount={2}
        mode="create"
        onOpenChange={(open) => { closeRequested = !open; }}
        onSubmit={() => false}
      />,
    ));
    await act(async () => buttonWithText('Create group').click());
    assert.equal(closeRequested, false);
    assert.ok(document.body.querySelector('input[maxlength="100"]'),
      'the entered name remains available for retry');
  });

  it('adds a clash to an existing group (#5122)', async () => {
    const checkboxes = [...container!.querySelectorAll('input[type="checkbox"]')]
      .filter((input) => input.getAttribute('aria-label')?.startsWith('Select clash '));
    assert.equal(checkboxes.length, 2, 'each pair row must offer grouping selection');

    // Create initial group with first clash
    await act(async () => {
      (checkboxes[0] as HTMLInputElement).click();
    });
    const groupButton = buttonWithText('Group selected (1)');
    assert.ok(groupButton.disabled, 'create button requires 2+ clashes');

    // Deselect and select both for initial group creation
    await act(async () => {
      (checkboxes[0] as HTMLInputElement).click();
    });
    await act(async () => {
      for (const checkbox of checkboxes) (checkbox as HTMLInputElement).click();
    });
    await act(async () => buttonWithText('Group selected (2)').click());
    await setDialogName('Riser coordination');
    await act(async () => buttonWithText('Create group').click());

    const initialStored = JSON.parse(localStorage.getItem(MANUAL_CLASH_GROUPS_KEY) ?? 'null') as { groups: Array<{ name: string; members: unknown[] }> };
    assert.equal(initialStored.groups[0].members.length, 2, 'initial group has 2 members');

    // Now we have result() with 2 clashes (c1, c2). Let's create a third result for testing adds.
    const extendedResult: ClashResult = {
      clashes: [clash('c1', 1, 2), clash('c2', 3, 4), clash('c3', 5, 6)],
      summary: summarizeClashes([clash('c1', 1, 2), clash('c2', 3, 4), clash('c3', 5, 6)]),
      rulesRun: [{ id: 'coordination', name: 'Coordination', a: 'IfcWall', b: 'IfcPipeSegment', mode: 'hard' }],
      settings: { tolerance: 0.002, excludeVoidsAndHosts: true },
    };
    await act(async () => {
      useViewerStore.setState({ clashResult: extendedResult });
    });

    // Get the "Add" button from the group header
    const addButton = container!.querySelector('button[title="Add selected clashes to this group"]');
    assert.ok(addButton instanceof HTMLButtonElement, 'add-to-group button must render');

    // Select the new clash (c3)
    const newCheckboxes = [...container!.querySelectorAll('input[type="checkbox"]')]
      .filter((input) => input.getAttribute('aria-label')?.startsWith('Select clash '));
    assert.equal(newCheckboxes.length, 3, 'must have 3 checkboxes for 3 clashes');

    // Find and click the checkbox for c3
    const c3Checkbox = newCheckboxes.find((cb) => {
      const label = cb.getAttribute('aria-label') ?? '';
      return label.includes('c3');
    });
    assert.ok(c3Checkbox instanceof HTMLInputElement, 'c3 checkbox must exist');
    await act(async () => {
      c3Checkbox.click();
    });

    // Click the Add button
    await act(async () => {
      addButton.click();
    });

    // The dialog should appear with "Add to Riser coordination" message
    const dialogButton = buttonWithText('Add');
    await act(async () => {
      dialogButton.click();
    });

    const afterAdd = JSON.parse(localStorage.getItem(MANUAL_CLASH_GROUPS_KEY) ?? 'null') as { groups: Array<{ name: string; members: unknown[] }> };
    assert.equal(afterAdd.groups[0].members.length, 3, 'group now has 3 members after add');
    assert.equal(afterAdd.groups[0].name, 'Riser coordination', 'group name unchanged');
  });

  it('focuses full group membership even when some clashes are hidden by filter (#5122)', async () => {
    const checkboxes = [...container!.querySelectorAll('input[type="checkbox"]')]
      .filter((input) => input.getAttribute('aria-label')?.startsWith('Select clash '));

    // Create a group with both clashes
    await act(async () => {
      for (const checkbox of checkboxes) (checkbox as HTMLInputElement).click();
    });
    await act(async () => buttonWithText('Group selected (2)').click());
    await setDialogName('Focus test group');
    await act(async () => buttonWithText('Create group').click());

    // Once both clashes are grouped, they no longer render as top-level
    // `row.kind === 'clash'` rows (ClashPanel.tsx), so the per-clash
    // "Select clash " checkboxes are gone entirely — that count can't be
    // used to observe the filter. Instead read the group header's own
    // count badge, which display-rows.ts sets to `section.items.length`,
    // the visibility-filtered member list computed in
    // useManualClashGroups.ts. It must start at 2 (both members).
    const groupHeaderCount = (): string | null => {
      const header = container!.querySelector('button[aria-label="Collapse Focus test group"]');
      assert.ok(header instanceof HTMLButtonElement, 'group header toggle button must render');
      const countSpan = header.querySelector('span.tabular-nums');
      assert.ok(countSpan, 'group header count badge must render');
      return countSpan.textContent;
    };
    assert.equal(groupHeaderCount(), '2', 'group header count reflects both members before filtering');

    // Mark the second clash as reviewed so the status filter below keeps it
    // visible while the first (untouched, default 'open') is hidden.
    const clashResult = useViewerStore.getState().clashResult;
    const secondClash = clashResult?.clashes[1];
    assert.ok(secondClash, 'second clash must exist');

    // Review status is looked up by `clashReviewKey` (rule + the two durable
    // element keys), NOT by `Clash.id` (hooks/useClash.ts's `reviewOf`), so the
    // map must be keyed that way for the lookup to actually hit. Mark only the
    // second clash 'accepted' and leave the first clash without an entry, which
    // `reviewOf` defaults to 'open'. The status filter below keeps only
    // resolved/accepted, so this hides the first clash and keeps the second.
    await act(async () => {
      useViewerStore.setState({
        clashStatusFilter: new Set(['resolved', 'accepted']),
        clashReviews: new Map([
          [clashReviewKey(secondClash), { status: 'accepted', date: new Date() }],
        ]),
      });
    });

    // The group header count must drop to 1: this is the precondition that
    // proves the filter genuinely narrowed the group's visible membership
    // (section.items), as distinct from its full membership (membersById).
    // Without this check, a filter that silently failed to apply would
    // still leave focus selecting all four elements below, and the test
    // would pass for the wrong reason.
    assert.equal(groupHeaderCount(), '1', 'group header count reflects the filter narrowing visible membership');

    // Click the Focus button
    const focusButton = container!.querySelector('button[title="Focus every object in this group"]');
    assert.ok(focusButton instanceof HTMLButtonElement, 'focus button must render');
    await act(async () => {
      focusButton.click();
    });

    // Focus should include BOTH group members, not just the visible one. The
    // real `focusClashGroup` pipeline (group-focus.ts) writes every resolved
    // element into the store's `selectedEntityIds`, so that is the observable
    // signal here rather than a stubbed `focusClashes` — `focusClashes` is a
    // `useClash()` closure, not store state, so a `setState` stub is never
    // read by the real click handler.
    const selectedEntityIds = useViewerStore.getState().selectedEntityIds;
    assert.deepEqual(
      [...selectedEntityIds].sort((a, b) => a - b),
      [1, 2, 3, 4],
      'focus selects all four elements of both group members, not just the visible clash\'s pair',
    );
  });
});
