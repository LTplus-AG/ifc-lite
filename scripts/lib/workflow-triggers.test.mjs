/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DirtyPrScanError } from './dirty-pr-scan.mjs';
import { topLevelTriggerNames } from './workflow-triggers.mjs';

test('topLevelTriggerNames: reads every key directly under `on:`', () => {
  assert.deepEqual(
    topLevelTriggerNames('on:\n  workflow_dispatch:\n  schedule:\n    - cron: "*/30 * * * *"\n  push:\n    branches: [main]\nconcurrency:\n  group: x\n'),
    ['workflow_dispatch', 'schedule', 'push'],
  );
});

test('topLevelTriggerNames: stops at the next top-level key, not just `concurrency:`', () => {
  assert.deepEqual(topLevelTriggerNames('on:\n  push:\n    branches: [main]\njobs:\n  scan:\n    runs-on: ubuntu-latest\n'), ['push']);
});

test('topLevelTriggerNames: a nested key (e.g. `branches:`) is not mistaken for a trigger', () => {
  assert.deepEqual(topLevelTriggerNames('on:\n  push:\n    branches: [main]\n    tags: ["v*"]\n  pull_request:\njobs:\n'), [
    'push',
    'pull_request',
  ]);
});

test('topLevelTriggerNames: blank and comment lines between triggers do not truncate the list', () => {
  assert.deepEqual(topLevelTriggerNames('on:\n  workflow_dispatch:\n\n  # nightly sweep\n  schedule:\n    - cron: "0 0 * * *"\njobs:\n'), [
    'workflow_dispatch',
    'schedule',
  ]);
});

test('topLevelTriggerNames: a scalar `on:` value is a single trigger', () => {
  assert.deepEqual(topLevelTriggerNames('on: push\njobs:\n  scan:\n    runs-on: ubuntu-latest\n'), ['push']);
});

test('topLevelTriggerNames: a flow-sequence `on:` value lists every trigger', () => {
  assert.deepEqual(topLevelTriggerNames('on: [push, workflow_dispatch]\njobs:\n'), ['push', 'workflow_dispatch']);
});

test('topLevelTriggerNames: a quoted `"on":` key is still recognized', () => {
  assert.deepEqual(topLevelTriggerNames('"on":\n  push:\n    branches: [main]\n  workflow_dispatch:\njobs:\n'), [
    'push',
    'workflow_dispatch',
  ]);
});

test('topLevelTriggerNames: 4-space indentation is read by its own width, not a hardcoded 2', () => {
  assert.deepEqual(
    topLevelTriggerNames('on:\n    push:\n        branches: [main]\n    workflow_dispatch:\njobs:\n'),
    ['push', 'workflow_dispatch'],
  );
});

test('topLevelTriggerNames: tab-indented triggers parse the same as space-indented ones', () => {
  assert.deepEqual(
    topLevelTriggerNames('on:\n\tpush:\n\t\tbranches: [main]\n\tworkflow_dispatch:\njobs:\n'),
    ['push', 'workflow_dispatch'],
  );
});

test('topLevelTriggerNames: fails closed on a workflow with no `on:` block', () => {
  assert.throws(() => topLevelTriggerNames('jobs:\n  scan:\n    runs-on: ubuntu-latest\n'), (err) => {
    assert.ok(err instanceof DirtyPrScanError);
    assert.equal(err.reason, 'NO_ON_BLOCK');
    return true;
  });
});

test('topLevelTriggerNames: fails closed on an `on:` block with no triggers', () => {
  assert.throws(() => topLevelTriggerNames('on:\njobs:\n  scan:\n    runs-on: ubuntu-latest\n'), (err) => {
    assert.ok(err instanceof DirtyPrScanError);
    assert.equal(err.reason, 'NO_TRIGGERS');
    return true;
  });
});
