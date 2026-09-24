/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `@theme` bridge in `index.css` compiles to utilities that resolve
 * through the runtime `--overlay-*` properties, and the z scale is a
 * runtime property Tailwind's `z-(--z-hud)` reads (#5483). Compiled with the
 * real Tailwind v4 plugin chain from `postcss.config.js`; the candidates are
 * safelisted inline because nothing in the app consumes them yet.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import tailwindcss from '@tailwindcss/postcss';
import { OVERLAY_TOKENS, overlayCssVar } from './overlay-theme';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '../..');

/** SVG utilities the section overlay paints with (#5488): each must compile to its token. */
const SVG_UTILITIES = [
  ['fill-axis-x', 'fill', 'axis-x'],
  ['fill-axis-y', 'fill', 'axis-y'],
  ['fill-axis-z', 'fill', 'axis-z'],
  ['fill-overlay-accent', 'fill', 'overlay-accent'],
  ['fill-overlay-accent-soft', 'fill', 'overlay-accent-soft'],
  ['fill-overlay-ink', 'fill', 'overlay-ink'],
  ['stroke-overlay-halo', 'stroke', 'overlay-halo'],
] as const;

const CANDIDATES = [
  'z-(--z-hud)', 'z-(--z-toast)', 'stroke-overlay-accent', 'bg-overlay-accent-soft', 'text-axis-x', 'bg-paper',
  ...SVG_UTILITIES.map(([cls]) => cls),
];

async function compile(): Promise<string> {
  const input = `@import "./index.css";\n@source inline("${CANDIDATES.join(' ')}");\n`;
  const result = await postcss([tailwindcss()]).process(input, { from: join(SRC, 'overlay-theme.probe.css'), to: undefined });
  return result.css;
}

/** The declarations of every rule whose selector list contains `selector`, later rules winning. */
function declarationsOf(css: string, selector: string): Map<string, string> {
  const root = postcss.parse(css);
  const out = new Map<string, string>();
  root.walkRules((rule) => {
    if (!rule.selectors.includes(selector)) return;
    rule.walkDecls((decl) => {
      out.set(decl.prop, decl.value);
    });
  });
  assert.ok(out.size > 0, `no rule for ${selector}`);
  return out;
}

describe('overlay @theme bridge and z scale (#5483)', () => {
  it('the z scale is published on :root and z-(--z-hud) reads it', async () => {
    const css = await compile();
    const root = declarationsOf(css, ':root');
    assert.deepEqual(
      ['scene', 'hud', 'hud-popover', 'float', 'chrome', 'modal', 'toast'].map((k) => root.get(`--z-${k}`)),
      ['10', '20', '30', '40', '50', '60', '70'],
    );
    assert.equal(declarationsOf(css, '.z-\\(--z-hud\\)').get('z-index'), 'var(--z-hud)');
    assert.equal(declarationsOf(css, '.z-\\(--z-toast\\)').get('z-index'), 'var(--z-toast)');
  });

  it('every token has a --color-* alias pointing at its runtime property', async () => {
    const css = await compile();
    const root = declarationsOf(css, ':root');
    for (const token of OVERLAY_TOKENS) {
      assert.equal(root.get(`--color-${token}`), `var(${overlayCssVar(token)})`, token);
    }
  });

  it('utilities resolve through the alias, so a theme switch on <html> recolours them', async () => {
    const css = await compile();
    assert.equal(declarationsOf(css, '.stroke-overlay-accent').get('stroke'), 'var(--color-overlay-accent)');
    assert.equal(declarationsOf(css, '.bg-overlay-accent-soft').get('background-color'), 'var(--color-overlay-accent-soft)');
    assert.equal(declarationsOf(css, '.text-axis-x').get('color'), 'var(--color-axis-x)');
    assert.equal(declarationsOf(css, '.bg-paper').get('background-color'), 'var(--color-paper)');
  });

  it('the section overlay SVG fill/stroke utilities resolve to their tokens (#5488)', async () => {
    const css = await compile();
    for (const [cls, prop, token] of SVG_UTILITIES) {
      assert.equal(declarationsOf(css, `.${cls}`).get(prop), `var(--color-${token})`, cls);
    }
  });
});
