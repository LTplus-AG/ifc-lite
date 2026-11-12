/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The idle warm step for the schema tables (`warm-schema-tables.ts`): it runs
 * only once a load has settled and only in idle periods, pauses for a new
 * load, and changes no answer an interaction gets, whether that interaction
 * comes before it or after.
 */

import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getInheritanceChainAcrossSchemas, getSchemaRegistryForVersion, normalizeIfcTypeName } from '@ifc-lite/parser';
import { getAttributeXsdTypes } from '@ifc-lite/data';
import { schemaTableWarmSteps, startSchemaTableWarm, type WarmEnv, type WarmStep } from './warm-schema-tables.js';

/** A controllable page: settled flag, schema version, idle periods released by hand. */
function fakeEnv(version: string | undefined) {
  let settled = false;
  let schemaVersion = version;
  const listeners = new Set<() => void>();
  const idleWaiters: Array<() => void> = [];
  const ran: string[] = [];
  const env: WarmEnv = {
    settled: () => settled,
    schemaVersion: () => schemaVersion,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    idle: () => new Promise((resolve) => idleWaiters.push(resolve)),
    steps: (v): WarmStep[] => ['a', 'b', 'c'].map((name) => ({ name, run: () => { ran.push(`${v}:${name}`); } })),
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    env,
    ran,
    setSettled: (value: boolean) => { settled = value; for (const l of listeners) l(); },
    setVersion: (value: string) => { schemaVersion = value; for (const l of listeners) l(); },
    /** Release one pending idle period and let the warm loop continue. */
    idle: async () => { idleWaiters.shift()?.(); await tick(); },
    pendingIdle: () => idleWaiters.length,
    tick,
  };
}

describe('schema table warm step', () => {
  it('does nothing while a load runs, then runs each step in its own idle period once it settles', async () => {
    const page = fakeEnv('IFC4');
    const stop = startSchemaTableWarm(page.env);
    await page.tick();
    assert.deepEqual(page.ran, [], 'nothing before a settled load');
    assert.equal(page.pendingIdle(), 0, 'not even waiting for idle before a settled load');

    page.setSettled(true);
    await page.tick();
    assert.deepEqual(page.ran, [], 'a settled load still waits for an idle period');
    await page.idle();
    assert.deepEqual(page.ran, ['IFC4:a']);
    await page.idle();
    await page.idle();
    assert.deepEqual(page.ran, ['IFC4:a', 'IFC4:b', 'IFC4:c'], 'one step per idle period, in order');
    stop();
  });

  it('pauses when a new load starts mid-warm and finishes after that load settles', async () => {
    const page = fakeEnv('IFC2X3');
    const stop = startSchemaTableWarm(page.env);
    page.setSettled(true);
    await page.tick();
    await page.idle();
    assert.deepEqual(page.ran, ['IFC2X3:a']);

    page.setSettled(false); // a new load begins
    await page.idle();
    assert.deepEqual(page.ran, ['IFC2X3:a'], 'no step runs inside the new load');

    page.setSettled(true);
    await page.tick();
    for (let i = 0; i < 3; i++) await page.idle();
    assert.deepEqual(page.ran.slice(1), ['IFC2X3:a', 'IFC2X3:b', 'IFC2X3:c'], 'the whole (idempotent) list runs after the load settles');
    stop();
  });

  it('warms each schema family once per page', async () => {
    const page = fakeEnv('IFC4');
    const stop = startSchemaTableWarm(page.env);
    page.setSettled(true);
    await page.tick();
    for (let i = 0; i < 3; i++) await page.idle();
    page.setSettled(true); // another state change after a second IFC4 model
    await page.tick();
    assert.equal(page.pendingIdle(), 0, 'an already warmed family schedules nothing');
    page.setVersion('IFC4X3');
    await page.tick();
    for (let i = 0; i < 3; i++) await page.idle();
    assert.deepEqual(page.ran, ['IFC4:a', 'IFC4:b', 'IFC4:c', 'IFC4X3:a', 'IFC4X3:b', 'IFC4X3:c']);
    stop();
  });

  it('an interaction before the warm step gets the same answers as after it, for every schema', () => {
    // Before: what a first property edit, metadata lookup and filter read.
    const before = {
      chain: getInheritanceChainAcrossSchemas('IfcWallStandardCase'),
      normalized: normalizeIfcTypeName('IFCWALL'),
      xsd: getAttributeXsdTypes('IFC4', 'IFCWALL', 'Name'),
      wall2x3: getSchemaRegistryForVersion('IFC2X3').entities.IfcWall?.inheritanceChain,
    };
    assert.ok(before.chain.includes('IfcRoot') && before.chain.includes('IfcWall'));
    for (const version of ['IFC2X3', 'IFC4', 'IFC4X3', undefined]) {
      for (const step of schemaTableWarmSteps(version)) step.run();
    }
    assert.deepEqual(getInheritanceChainAcrossSchemas('IfcWallStandardCase'), before.chain);
    assert.equal(normalizeIfcTypeName('IFCWALL'), before.normalized);
    assert.deepEqual(getAttributeXsdTypes('IFC4', 'IFCWALL', 'Name'), before.xsd);
    assert.deepEqual(getSchemaRegistryForVersion('IFC2X3').entities.IfcWall?.inheritanceChain, before.wall2x3);
  });

  it('names the steps a model of each schema warms', () => {
    assert.deepEqual(schemaTableWarmSteps('IFC4').map((s) => s.name), ['entity-union', 'type-names', 'registry-IFC4', 'attribute-xsd-IFC4']);
    assert.deepEqual(schemaTableWarmSteps('IFC2X3').map((s) => s.name), ['entity-union', 'type-names', 'registry-IFC4', 'registry-IFC2X3', 'attribute-xsd-IFC2X3']);
    assert.deepEqual(schemaTableWarmSteps('IFC5').map((s) => s.name), ['entity-union', 'type-names', 'registry-IFC4', 'registry-IFC4X3', 'attribute-xsd-IFC4X3']);
  });
});
