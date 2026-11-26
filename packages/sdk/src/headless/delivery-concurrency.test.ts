/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFile } from 'node:fs/promises';
import { IfcParser } from '@ifc-lite/parser';
import { expect, it, vi } from 'vitest';
import { loadModelForDelivery } from './delivery-checks.js';
import type { ResolvedDeliveryRecipe } from './delivery-recipe.js';
import { runDeliveryRecipe } from './delivery-runner.js';

function gate() {
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { release = resolve; });
  return { entered, release };
}

it('preserves application logging while overlapping deliveries finish out of order (#11622)', async () => {
  const bytes = await readFile(new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url));
  const firstStarted = gate();
  const secondStarted = gate();
  const finishFirst = gate();
  const finishSecond = gate();
  const parse = IfcParser.prototype.parseColumnar;
  const spy = vi.spyOn(IfcParser.prototype, 'parseColumnar')
    .mockImplementationOnce(async function (this: IfcParser, buffer, options) {
      firstStarted.release();
      await finishFirst.entered;
      return parse.call(this, buffer, options);
    })
    .mockImplementationOnce(async () => {
      secondStarted.release();
      await finishSecond.entered;
      throw new Error('broken model');
    });
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  function deliver(name: string) {
    const recipe: ResolvedDeliveryRecipe = {
      recipePath: '/delivery.json', models: [name], resolvedModels: [name],
      structural: true, ids: [], resolvedIds: [], rules: [], resolvedRules: [],
    };
    return runDeliveryRecipe(recipe, 'test', (path) =>
      loadModelForDelivery(path, async () => ({ bytes, name })));
  }

  try {
    const first = deliver('first.ifc');
    await firstStarted.entered;
    const second = deliver('second.ifc');
    await secondStarted.entered;
    console.log('unrelated application log');
    console.warn('unrelated application warning');

    finishFirst.release();
    const firstReport = await first;
    finishSecond.release();
    const secondReport = await second;

    expect(firstReport.models[0]).toMatchObject({ path: 'first.ifc', sha256: expect.any(String) });
    expect(secondReport.models[0]).toMatchObject({ path: 'second.ifc', loadError: 'could not be parsed: broken model' });
    expect(console.log).toBe(log);
    expect(console.warn).toBe(warn);
    expect(log).toHaveBeenCalledWith('unrelated application log');
    expect(warn).toHaveBeenCalledWith('unrelated application warning');
  } finally {
    console.log = log;
    console.warn = warn;
    log.mockRestore();
    warn.mockRestore();
    spy.mockRestore();
  }
});
