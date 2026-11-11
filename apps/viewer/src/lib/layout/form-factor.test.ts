/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #9718: every row of the issue's device table, plus the desktop cases, through
 * the one classifier. The sizes are CSS pixels as the devices report them.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFormFactor, mobileCommandPlacement, mobilePanelHost, type FormFactorInput, type SegmentRect } from './form-factor.js';

const touch = (width: number, height: number, segments?: SegmentRect[]): FormFactorInput =>
  ({ width, height, coarsePointer: true, segments });
const mouse = (width: number, height: number): FormFactorInput => ({ width, height, coarsePointer: false });

/** Two segments split by a hinge band, as `window.viewport.segments` reports them. */
const tabletop = (width: number, height: number, hinge = 20): SegmentRect[] => {
  const half = (height - hinge) / 2;
  return [{ x: 0, y: 0, width, height: half }, { x: 0, y: half + hinge, width, height: half }];
};
const book = (width: number, height: number, hinge = 20): SegmentRect[] => {
  const half = (width - hinge) / 2;
  return [{ x: 0, y: 0, width: half, height }, { x: half + hinge, y: 0, width: half, height }];
};

describe('classifyFormFactor: the #9718 device table', () => {
  const rows: Array<[string, FormFactorInput, string, string]> = [
    ['Galaxy Z Flip 8 main, portrait', touch(412, 960), 'phone-portrait', 'bottom-bar'],
    ['Flip 8 main, landscape', touch(960, 412), 'phone-landscape', 'side-rail'],
    ['Flip 8 FlexWindow cover', touch(360, 400), 'cover', 'bottom-bar'],
    ['Flip 8 FlexWindow cover, turned', touch(400, 360), 'cover', 'bottom-bar'],
    ['Flip 8 Flex Mode (tabletop)', touch(412, 960, tabletop(412, 960)), 'folded', 'bottom-bar'],
    ['iPhone 17/18 Pro', touch(402, 874), 'phone-portrait', 'bottom-bar'],
    ['iPhone 17/18 Pro Max', touch(440, 956), 'phone-portrait', 'bottom-bar'],
    ['iPhone Pro, landscape', touch(874, 402), 'phone-landscape', 'side-rail'],
    ['iPhone Pro Max, landscape', touch(956, 440), 'phone-landscape', 'side-rail'],
    ['iPhone Duo inner', touch(626, 890), 'tablet-touch', 'bottom-bar'],
    ['Z Fold inner', touch(830, 750), 'tablet-touch', 'bottom-bar'],
    ['Z Fold inner, half open (book)', touch(830, 750, book(830, 750)), 'folded', 'bottom-bar'],
    ['iPhone Duo outer', touch(466, 678), 'phone-portrait', 'bottom-bar'],
    ['iPhone Duo outer, landscape', touch(678, 466), 'phone-landscape', 'side-rail'],
  ];
  for (const [device, input, mode, placement] of rows) {
    it(`${device} (${input.width}x${input.height}) is ${mode} with a ${placement}`, () => {
      const result = classifyFormFactor(input);
      assert.equal(result.mode, mode);
      assert.equal(result.commandPlacement, placement);
    });
  }

  it('reports the fold orientation and both segments, so the panel placement can use them', () => {
    const flex = classifyFormFactor(touch(412, 960, tabletop(412, 960)));
    assert.equal(flex.fold?.orientation, 'tabletop');
    assert.deepEqual(flex.fold?.segments, tabletop(412, 960));
    assert.equal(classifyFormFactor(touch(830, 750, book(830, 750))).fold?.orientation, 'book');
  });

  it('only a cover screen under 360px wide compacts the bar', () => {
    assert.equal(classifyFormFactor(touch(352, 400)).compactCommands, true);
    assert.equal(classifyFormFactor(touch(360, 400)).compactCommands, false);
    // A 320px phone in portrait keeps all seven targets in one row (#8802).
    assert.equal(classifyFormFactor(touch(320, 568)).compactCommands, false);
  });

  it('an unfolded window (one segment, or none) is classified by its shape alone', () => {
    assert.equal(classifyFormFactor(touch(412, 960, [{ x: 0, y: 0, width: 412, height: 960 }])).mode, 'phone-portrait');
    assert.equal(classifyFormFactor(touch(412, 960)).fold, undefined);
  });
});

describe('classifyFormFactor: desktop and non-touch windows', () => {
  it('a desktop window is the desktop with the top ribbon', () => {
    assert.deepEqual(classifyFormFactor(mouse(1600, 1000)), { mode: 'desktop', commandPlacement: 'top-ribbon', compactCommands: false });
  });

  it('a non-touch window under 768px stays the phone layout', () => {
    assert.equal(classifyFormFactor(mouse(700, 900)).mode, 'phone-portrait');
    // Short and wide, but a mouse: not a phone on its side.
    assert.equal(classifyFormFactor(mouse(700, 400)).mode, 'phone-portrait');
  });

  it('a non-touch window from 768px is the desktop', () => {
    assert.equal(classifyFormFactor(mouse(768, 600)).mode, 'desktop');
  });

  it('an iPad in landscape at 1024px and wider is the desktop; in portrait a near-tablet', () => {
    assert.equal(classifyFormFactor(touch(1024, 768)).mode, 'desktop');
    assert.equal(classifyFormFactor(touch(1180, 820)).mode, 'desktop');
    assert.equal(classifyFormFactor(touch(820, 1180)).mode, 'tablet-touch');
  });

  it('a fold on a desktop-sized window does not leave the desktop', () => {
    assert.equal(classifyFormFactor(touch(1600, 1000, book(1600, 1000))).mode, 'desktop');
  });

  it('isMobile keeps the rule it replaced: width < 768, or touch and width < 1024', () => {
    for (let width = 240; width <= 1400; width += 8) {
      for (const height of [360, 412, 600, 900]) {
        for (const coarsePointer of [false, true]) {
          const old = width < 768 || (coarsePointer && width < 1024);
          const mode = classifyFormFactor({ width, height, coarsePointer }).mode;
          assert.equal(mode !== 'desktop', old, `${width}x${height} coarse=${coarsePointer}`);
        }
      }
    }
  });
});

describe('mobileCommandPlacement', () => {
  it('maps the landscape rail through, and everything else to the bottom bar', () => {
    assert.equal(mobileCommandPlacement(classifyFormFactor(touch(960, 412))), 'side-rail');
    assert.equal(mobileCommandPlacement(classifyFormFactor(touch(412, 960))), 'bottom-bar');
    // A store seeded with `isMobile` alone still holds the desktop form factor.
    assert.equal(mobileCommandPlacement(classifyFormFactor(mouse(1600, 1000))), 'bottom-bar');
  });
});

describe('mobilePanelHost: where an open panel lives (#9718 DoD 3-5)', () => {
  const rows: Array<[string, FormFactorInput, string]> = [
    ['Flip 8 main, portrait: a modal sheet', touch(412, 960), 'sheet'],
    ['iPhone Pro: a modal sheet', touch(402, 874), 'sheet'],
    ['iPhone Duo outer: a modal sheet', touch(466, 678), 'sheet'],
    ['Flip FlexWindow cover: a modal sheet', touch(360, 400), 'sheet'],
    ['Flip 8 landscape: a side pane, never a full-width sheet', touch(960, 412), 'side-pane'],
    ['iPhone Pro Max landscape: a side pane', touch(956, 440), 'side-pane'],
    ['Z Fold inner: a side pane', touch(830, 750), 'side-pane'],
    ['iPhone Duo inner: a side pane', touch(626, 890), 'side-pane'],
    ['Flip 8 Flex Mode (tabletop): the other segment', touch(412, 960, tabletop(412, 960)), 'segment'],
    ['Z Fold half open (book): the other segment', touch(830, 750, book(830, 750)), 'segment'],
    ['a narrow mouse window: a sheet', mouse(600, 800), 'sheet'],
  ];
  for (const [label, input, host] of rows) {
    it(label, () => assert.equal(mobilePanelHost(classifyFormFactor(input)), host));
  }
});
