/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #9718: every app page that themes itself (light and dark) must tell the
 * browser so. A page with no `color-scheme` is force-darkened by Samsung
 * Internet's dark mode and Chrome's auto dark theme, which invert the DOM but
 * not a WebGPU canvas: on a Galaxy foldable the light viewer showed dark
 * chrome and an inverted ViewCube over a light model view.
 *
 * Each page is parsed as the browser parses it, and the declaration read from
 * the resulting document's head.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Window } from 'happy-dom';

/** The self-themed pages, relative to the viewer app (the test's cwd). */
const SELF_THEMED_PAGES = ['index.html', '../landing/index.html', '../viewer-embed/index.html'];

const browserWindow = new Window({ url: 'http://localhost/' });

function declaredSchemes(page: string): Set<string> {
  const doc = new browserWindow.DOMParser().parseFromString(readFileSync(join(process.cwd(), page), 'utf8'), 'text/html');
  const meta = doc.head.querySelector('meta[name="color-scheme"]');
  return new Set((meta?.getAttribute('content') ?? '').split(/\s+/).filter(Boolean));
}

describe('self-themed pages declare color-scheme (#9718)', () => {
  for (const page of SELF_THEMED_PAGES) {
    it(`${page} declares light and dark, so browsers do not force-darken it`, () => {
      assert.deepEqual(declaredSchemes(page), new Set(['light', 'dark']));
    });
  }
});
