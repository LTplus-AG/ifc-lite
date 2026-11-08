// SPDX-License-Identifier: MPL-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { corpusBrowserMemory, runModelInFreshPage } from './browser.mjs';

// A stand-in for a Playwright page: `evaluate` answers in call order, so the
// helper's runModel -> measure memory -> dispose sequence is observable.
function fakeBrowser(answers) {
  const pages = [];
  return {
    pages,
    async newPage() {
      const page = { closed: false, calls: 0,
        async evaluate(_fn, arg) {
          const answer = answers[page.calls++];
          if (answer instanceof Error) throw answer;
          return typeof answer === 'function' ? answer(arg) : answer;
        },
        async close() { page.closed = true; } };
      pages.push(page);
      return page;
    },
  };
}

test('a crashed corpus page is reported for that model, closed, and not thrown', async () => {
  const browser = fakeBrowser([new Error('page.evaluate: Target crashed')]);
  const setup = [];
  const run = await runModelInFreshPage(browser, async page => setup.push(page), 'tests/models/big.ifc', []);
  assert.deepEqual(run, { error: 'page.evaluate: Target crashed' });
  assert.equal(browser.pages.length, 1);
  assert.equal(setup[0], browser.pages[0], 'the fresh page is initialised before the model runs');
  assert.equal(browser.pages[0].closed, true, 'a crashed page must still be released');
});

test('each corpus model gets its own page, measured and disposed before close', async () => {
  const shape = { model: 'tests/models/a.ifc' };
  const browser = fakeBrowser([model => ({ ...shape, ran: model }), { bytes: 4096 }, undefined]);
  const run = await runModelInFreshPage(browser, async () => {}, 'tests/models/a.ifc', []);
  assert.deepEqual(run, { result: { ...shape, ran: 'tests/models/a.ifc' }, browserMemory: { bytes: 4096 } });
  assert.equal(browser.pages[0].calls, 3, 'runModel, memory measurement and dispose all ran');
  assert.equal(browser.pages[0].closed, true);
});

test('a page that fails to close is recorded as a page error, not a crash', async () => {
  const browser = fakeBrowser([{}, { bytes: 1 }, undefined]);
  const original = browser.newPage;
  browser.newPage = async () => Object.assign(await original(), { close: async () => { throw new Error('already gone'); } });
  const pageErrors = [];
  const run = await runModelInFreshPage(browser, async () => {}, 'tests/models/a.ifc', pageErrors);
  assert.equal(run.error, undefined);
  assert.deepEqual(pageErrors, ['Error: already gone']);
});

test('corpus browser memory is the largest measurement, skipping crashed and unmeasured models', () => {
  assert.deepEqual(corpusBrowserMemory([
    { model: 'a', browserMemory: { bytes: 10 } },
    { model: 'b', crashed: true, error: 'Target crashed' },
    { model: 'c', browserMemory: { bytes: null, reason: 'measureUserAgentSpecificMemory unavailable' } },
    { model: 'd', browserMemory: { bytes: 30 } },
  ]), { bytes: 30, basis: 'max over per-model fresh pages (corpus mode)' });
  assert.deepEqual(corpusBrowserMemory([{ model: 'b', crashed: true, error: 'x' }]),
    { bytes: null, basis: 'max over per-model fresh pages (corpus mode)' });
});
