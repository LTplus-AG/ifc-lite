/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `bcfSlice` is one of the 17 slices in #2802 with zero test references.
 *
 * The property pinned here is specifically "a delete clears the pointers that
 * referenced what was deleted", and it is chosen because this codebase has
 * ALREADY shipped that defect: #2765 found `lensSlice.deleteLens` leaving
 * `activeLensId` pointing at a lens that no longer existed, and nothing failed.
 * `bcfSlice` is the largest untested surface with the same shape — six delete
 * paths and two active pointers — so a regression here would be silent in
 * exactly the same way.
 *
 * The slice is CORRECT today. That is worth stating plainly: this is regression
 * cover for behaviour that already works, not a bug fix. It earns its place
 * because the failure mode is invisible — a dangling `activeTopicId` renders as
 * an empty panel, not as an error — and because the identical defect has
 * occurred here before.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from 'zustand/vanilla';
import type { BCFProject, BCFTopic, BCFViewpoint } from '@ifc-lite/bcf';
import { createBcfSlice, type BCFSlice } from './bcfSlice.js';

const viewpoint = (guid: string): BCFViewpoint => ({ guid }) as BCFViewpoint;

const topic = (guid: string, viewpoints: BCFViewpoint[] = []): BCFTopic =>
  ({
    guid,
    title: `Topic ${guid}`,
    creationDate: '2026-08-18T00:00:00Z',
    creationAuthor: 'test@example.com',
    comments: [],
    viewpoints,
  }) as BCFTopic;

const project = (...topics: BCFTopic[]): BCFProject => ({
  version: '2.1',
  topics: new Map(topics.map((t) => [t.guid, t])),
});

const make = () => createStore<BCFSlice>(createBcfSlice);

describe('bcfSlice: a delete clears the pointers into what it deleted', () => {
  it('deleting the ACTIVE topic clears both the topic and viewpoint pointers', () => {
    // Both, because the viewpoint pointer refers to a viewpoint that lived on
    // the deleted topic: clearing only the topic leaves the second pointer
    // dangling, which is the harder half to notice.
    const s = make();
    s.getState().setBcfProject(project(topic('T1', [viewpoint('V1')]), topic('T2')));
    s.getState().setActiveTopic('T1');
    s.getState().setActiveViewpoint('V1');

    s.getState().deleteTopic('T1');

    assert.equal(s.getState().activeTopicId, null);
    assert.equal(s.getState().activeViewpointId, null, 'the viewpoint belonged to the deleted topic');
    assert.equal(s.getState().bcfProject?.topics.has('T1'), false);
    assert.equal(s.getState().bcfProject?.topics.has('T2'), true, 'the survivor stays');
  });

  it('deleting a DIFFERENT topic leaves the active pointers alone', () => {
    // The bounding control. Clearing unconditionally would satisfy the
    // assertion above while throwing the user out of the topic they are
    // reading every time any other topic is deleted.
    const s = make();
    s.getState().setBcfProject(project(topic('T1', [viewpoint('V1')]), topic('T2')));
    s.getState().setActiveTopic('T1');
    s.getState().setActiveViewpoint('V1');

    s.getState().deleteTopic('T2');

    assert.equal(s.getState().activeTopicId, 'T1');
    assert.equal(s.getState().activeViewpointId, 'V1');
  });

  it('deleting the ACTIVE viewpoint clears the viewpoint pointer only', () => {
    const s = make();
    s.getState().setBcfProject(project(topic('T1', [viewpoint('V1'), viewpoint('V2')])));
    s.getState().setActiveTopic('T1');
    s.getState().setActiveViewpoint('V1');

    s.getState().deleteViewpoint('T1', 'V1');

    assert.equal(s.getState().activeViewpointId, null);
    assert.equal(s.getState().activeTopicId, 'T1', 'the topic is still open');
    assert.deepEqual(
      s.getState().bcfProject?.topics.get('T1')?.viewpoints.map((v) => v.guid),
      ['V2'],
    );
  });

  it('deleting a DIFFERENT viewpoint leaves the active one selected', () => {
    const s = make();
    s.getState().setBcfProject(project(topic('T1', [viewpoint('V1'), viewpoint('V2')])));
    s.getState().setActiveViewpoint('V1');

    s.getState().deleteViewpoint('T1', 'V2');

    assert.equal(s.getState().activeViewpointId, 'V1');
  });

  it('loading a new project drops pointers into the old one', () => {
    // Ids are GUIDs, so a collision is unlikely rather than impossible — and
    // the failure would be a pointer into the PREVIOUS project resolving
    // against the new one, which is worse than a dangling pointer.
    const s = make();
    s.getState().setBcfProject(project(topic('T1', [viewpoint('V1')])));
    s.getState().setActiveTopic('T1');
    s.getState().setActiveViewpoint('V1');

    s.getState().setBcfProject(project(topic('T9')));

    assert.equal(s.getState().activeTopicId, null);
    assert.equal(s.getState().activeViewpointId, null);
  });

  it('clearing the project clears the pointers with it', () => {
    const s = make();
    s.getState().setBcfProject(project(topic('T1', [viewpoint('V1')])));
    s.getState().setActiveTopic('T1');
    s.getState().setActiveViewpoint('V1');

    s.getState().clearBcfProject();

    assert.equal(s.getState().bcfProject, null);
    assert.equal(s.getState().activeTopicId, null);
    assert.equal(s.getState().activeViewpointId, null);
  });

  it('a delete against a project that is not loaded is a no-op, not a crash', () => {
    // Reachable through an undo/redo or a panel action racing a project close.
    const s = make();
    s.getState().deleteTopic('T1');
    s.getState().deleteViewpoint('T1', 'V1');
    assert.equal(s.getState().bcfProject, null);
  });

  it('a delete naming a topic that is not there leaves the project untouched', () => {
    const s = make();
    s.getState().setBcfProject(project(topic('T1')));
    s.getState().setActiveTopic('T1');

    s.getState().deleteViewpoint('T-missing', 'V1');

    assert.equal(s.getState().activeTopicId, 'T1');
    assert.equal(s.getState().bcfProject?.topics.size, 1);
  });
});
