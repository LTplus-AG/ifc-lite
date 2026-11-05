/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { requiredModule } from './required-module';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { WorkflowReport } from '../../../../../tools/localization-shared/workflow-verdict.mjs';

interface Verdict {
  expectedChecks: readonly string[];
  workflowFailed(report: WorkflowReport): boolean;
  collectPageErrors(page: EventEmitter, report: WorkflowReport): void;
}

export function workflowContract(locale: string, negotiationCheck: string, loadVerdict: () => Promise<Verdict>): void {
  // DE-ASTRA-002 / FR-ASTRA-002: certify the runner's exact check contract,
  // independently of the verdict's exported list; an empty runner cannot pass.
  const names = [
    'render-device-health', 'hierarchy-properties', 'measurement', 'section',
    'ids-findings-export', 'narrow-layout', 'locale-url', 'locale-persistence',
    'locale-english-url', negotiationCheck,
  ];
  const complete = (): WorkflowReport => ({ mode: 'acceptance', errors: [],
    checks: names.map(name => ({ name, status: 'pass' })) });

  test(`${locale} workflow requires the exact unique passing acceptance check set`, async () => {
    const verdict = await requiredModule(loadVerdict, `${locale} acceptance workflow must be available`);
    assert.deepEqual(verdict.expectedChecks, names);
    assert.equal(verdict.workflowFailed(complete()), false);
    const reordered = complete(); reordered.checks.reverse();
    assert.equal(verdict.workflowFailed(reordered), false);
    const invalid: WorkflowReport[] = [
      { ...complete(), checks: [] },
      { ...complete(), checks: complete().checks.slice(1) },
      { ...complete(), mode: 'inspection' },
      { ...complete(), mode: undefined },
      { ...complete(), diagnostic: true },
      { ...complete(), fatal: 'load failed' },
      { ...complete(), errors: ['uncaught failure'] },
    ];
    for (const status of ['fail', 'skip', 'skipped', 'pending', '']) {
      const report = complete(); report.checks[0].status = status; invalid.push(report);
    }
    const duplicate = complete(); duplicate.checks[0] = duplicate.checks[1]; invalid.push(duplicate);
    const unknown = complete(); unknown.checks[0].name = 'unknown'; invalid.push(unknown);
    const extra = complete(); extra.checks.push({ name: 'unexpected', status: 'pass' }); invalid.push(extra);
    for (const report of invalid) assert.equal(verdict.workflowFailed(report), true, JSON.stringify(report));
  });

  test(`${locale} DE-ASTRA-002: every page error, including fresh negotiation, fails acceptance`, async () => {
    const verdict = await requiredModule(loadVerdict, `${locale} acceptance workflow must be available`);
    for (const pageName of ['main', 'fresh negotiation']) {
      const pages = { main: new EventEmitter(), 'fresh negotiation': new EventEmitter() };
      const report = complete();
      for (const page of Object.values(pages)) verdict.collectPageErrors(page, report);
      assert.equal(verdict.workflowFailed(report), false);
      for (const message of ['uncaught async failure', 'second page failure']) {
        pages[pageName as keyof typeof pages].emit('pageerror', new Error(message));
        assert.match(report.errors.at(-1) ?? '', new RegExp(message));
        assert.equal(verdict.workflowFailed(report), true);
      }
      assert.equal(report.errors.length, 2);
    }
  });
}
