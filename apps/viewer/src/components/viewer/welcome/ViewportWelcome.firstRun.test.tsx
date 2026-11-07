/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The first-run start screen asks "New here?" once (#8802 R6). The tour
 * invite used to ask it in the action column and the footer asked it again
 * with a different answer; now one line offers both the docs site and the
 * tour. The agent link left the sample-model list for that quiet line, and
 * the format list is plain text rather than a dimmed monospace run.
 */

import '@/test/setup-dom.js';
import { after, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, render } from '@/test/render.js';
import { viewportLightingEn } from '@/i18n/catalogues/viewport-lighting.en';
import { toursEn } from '@/i18n/catalogues/tours.en';
import { fieldTelemetry } from '@/lib/perf/fieldTelemetryLoader.js';
import { ViewportWelcome } from './ViewportWelcome.js';

const PROMPT = viewportLightingEn['viewportLighting.container.emptyState.footer.discoverPrompt'] as string;
const TOUR = toursEn['tours.tourInvite.start'];
const LLM = viewportLightingEn['viewportLighting.container.emptyState.driveWithLlm'] as string;
const SAMPLES = viewportLightingEn['viewportLighting.container.emptyState.noModel.heading'] as string;

function renderWelcome(supported = true) {
  return render(
    <ViewportWelcome
      webgpu={{ supported, checking: false }}
      onOpenClick={() => undefined}
      onStartBlank={() => undefined}
      recentFiles={[]}
      loadFile={() => Promise.resolve()}
    />,
  );
}

const ownText = (el: Element) => [...el.childNodes].filter((n) => n.nodeType === n.TEXT_NODE).map((n) => n.textContent ?? '').join('').trim();

after(() => fieldTelemetry?.resetFieldEventsForTests());
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('first-run start screen (#8802 R6)', () => {
  it('asks "New here?" once, and that line offers both the docs site and the tour', () => {
    const screen = renderWelcome();
    const prompts = [...screen.querySelectorAll('*')].filter((el) => ownText(el) === PROMPT);
    assert.equal(prompts.length, 1, 'one "New here?" on the screen');
    const line = screen.querySelector('[data-welcome-learn-line]');
    assert.ok(line, 'the learn line renders');
    assert.ok(line.contains(prompts[0]), 'the prompt heads the learn line');
    assert.ok(line.querySelector('a[href="https://ifclite.dev"]'), 'the line links the docs');
    assert.ok([...line.querySelectorAll('button')].some((b) => b.textContent?.trim() === TOUR), 'the line offers the tour');
  });

  it('keeps the docs answer when the tour is not offered (no WebGPU)', () => {
    const screen = renderWelcome(false);
    const line = screen.querySelector('[data-welcome-learn-line]');
    assert.ok(line, 'the learn line renders');
    assert.ok(line.querySelector('a[href="https://ifclite.dev"]'));
    assert.ok(![...line.querySelectorAll('button')].some((b) => b.textContent?.trim() === TOUR));
  });

  it('lists only sample models under "No model handy?" and keeps the agent link reachable', () => {
    const screen = renderWelcome();
    const heading = [...screen.querySelectorAll('h3')].find((h) => h.textContent?.trim() === SAMPLES);
    const samples = heading?.closest('section');
    assert.ok(samples, 'the sample list renders');
    assert.equal(samples.querySelector('a[href="/mcp"]'), null, 'the agent route is not a sample model');
    const agent = screen.querySelector<HTMLAnchorElement>('a[href="/mcp"]');
    assert.equal(agent?.textContent?.trim(), LLM, 'the agent route stays one click away');
  });

  it('names the formats as plain text, not a dimmed monospace run', () => {
    const formats = renderWelcome().querySelector('[data-welcome-formats]');
    assert.ok(formats);
    assert.doesNotMatch(formats.className, /\bfont-mono\b|\bopacity-/);
  });
});
