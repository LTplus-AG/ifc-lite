/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #5388: IfcAnnotation lines and text stayed black in the dark theme because
// the viewer never called `Renderer.setOverlayLineColor` and unstyled labels
// fell back to the renderer's near-black. The invariant tested here: whatever
// reaches the renderer clears the 3:1 contrast floor against the backdrop of
// the active theme, and the light theme keeps the renderer's own defaults.
import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useRef } from 'react';
import type { Renderer } from '@ifc-lite/renderer';
import { render, cleanup } from '@/test/render.js';
import type { ThemeMode } from '@/store/slices/uiSlice';
import type { AnnotationText3D } from '@/hooks/symbolic-rich-channels';
import { useAnnotationInk } from './useAnnotationInk.js';
import {
  annotationBackdrop,
  contrastRatio,
  legibleAnnotationTextColor,
  MIN_TEXT_CONTRAST,
} from '@/lib/annotation-ink';

afterEach(cleanup);

const THEMES: ThemeMode[] = ['light', 'dark', 'colorful'];

function text(color?: [number, number, number, number]): AnnotationText3D {
  return {
    origin: [0, 0, 0], worldPos: [0, 0, 0], dirX: 1, dirZ: 0, height: 0.3,
    content: 'FZK-Haus', alignment: 'bottom-left', color, definesExtent: true,
  };
}

/** Records what the hook sends to the renderer. */
function recordingRenderer() {
  const sent = { lineColors: [] as number[][], texts: [] as AnnotationText3D[][] };
  const renderer = {
    setOverlayLineColor: (c: readonly number[]) => { sent.lineColors.push([...c]); },
    uploadAnnotationTexts3D: (t: AnnotationText3D[]) => { sent.texts.push(t); },
    requestRender: () => {},
  };
  return { sent, renderer: renderer as unknown as Renderer };
}

function mountInk(theme: ThemeMode, texts: AnnotationText3D[]) {
  const { sent, renderer } = recordingRenderer();
  function Probe() {
    const ref = useRef<Renderer | null>(renderer);
    useAnnotationInk(ref, true, theme, texts);
    return null;
  }
  render(<Probe />);
  return sent;
}

describe('useAnnotationInk (#5388)', () => {
  for (const theme of THEMES) {
    it(`${theme}: line colour and label colours clear ${MIN_TEXT_CONTRAST}:1 against the backdrop`, () => {
      const sent = mountInk(theme, [text(), text([0, 0, 0, 1]), text([1, 1, 1, 1])]);
      const backdrop = annotationBackdrop(theme);
      assert.equal(sent.lineColors.length, 1, 'the overlay line colour is set');
      assert.ok(contrastRatio(sent.lineColors[0], backdrop) >= MIN_TEXT_CONTRAST);
      const uploaded = sent.texts.at(-1)!;
      assert.equal(uploaded.length, 3);
      for (const t of uploaded) {
        assert.ok(t.color, 'every label is uploaded with an explicit colour');
        assert.ok(contrastRatio(t.color, backdrop) >= MIN_TEXT_CONTRAST, `${t.color} on ${theme}`);
      }
    });
  }

  it('light theme keeps the renderer defaults (black lines, near-black unstyled text)', () => {
    const sent = mountInk('light', [text()]);
    assert.deepEqual(sent.lineColors[0], [0, 0, 0, 1]);
    assert.deepEqual(sent.texts.at(-1)![0].color, [0.05, 0.05, 0.05, 1]);
  });
});

describe('legibleAnnotationTextColor (#5388)', () => {
  it('keeps an authored colour that is already legible', () => {
    assert.deepEqual(legibleAnnotationTextColor([0.9, 0.2, 0.1, 1], 'dark'), [0.9, 0.2, 0.1, 1]);
    assert.deepEqual(legibleAnnotationTextColor([0, 0, 0.6, 1], 'light'), [0, 0, 0.6, 1]);
  });

  it('lifts an authored dark colour only as far as the floor, keeping its alpha', () => {
    const lifted = legibleAnnotationTextColor([0, 0, 0.4, 0.8], 'dark');
    const backdrop = annotationBackdrop('dark');
    const ratio = contrastRatio(lifted, backdrop);
    assert.ok(ratio >= MIN_TEXT_CONTRAST && ratio < MIN_TEXT_CONTRAST + 0.05, `ratio ${ratio}`);
    assert.equal(lifted[3], 0.8);
    assert.ok(lifted[2] > lifted[0], 'the blue cast survives');
  });
});
