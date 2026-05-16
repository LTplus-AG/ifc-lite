/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { clampOverlay, overlayParagraphDiff } from './overlay.js';

describe('clampOverlay', () => {
  it('returns the input unchanged when under the cap', () => {
    const r = clampOverlay('hello world', { maxTokens: 100 });
    expect(r.truncated).toBe(false);
    expect(r.overlay.content).toBe('hello world');
  });

  it('truncates when over the cap', () => {
    const long = 'x'.repeat(5000);
    const r = clampOverlay(long, { maxTokens: 100 });
    expect(r.truncated).toBe(true);
    expect(r.overlay.content.length).toBeLessThan(long.length);
    expect(r.overlay.content).toContain('[truncated]');
  });

  it('strips trailing whitespace', () => {
    const r = clampOverlay('hello   \n\n', { maxTokens: 100 });
    expect(r.overlay.content).toBe('hello');
  });

  it('stamps updatedAt from the clock option', () => {
    const r = clampOverlay('x', { maxTokens: 100, now: () => new Date('2026-05-01') });
    expect(r.overlay.updatedAt).toBe('2026-05-01T00:00:00.000Z');
  });
});

describe('overlayParagraphDiff', () => {
  it('reports same content', () => {
    const r = overlayParagraphDiff('A\n\nB', 'A\n\nB');
    expect(r.same).toBe(true);
    expect(r.addedParagraphs).toEqual([]);
  });

  it('reports added paragraphs', () => {
    const r = overlayParagraphDiff('A', 'A\n\nB');
    expect(r.same).toBe(false);
    expect(r.addedParagraphs).toEqual(['B']);
  });

  it('reports removed paragraphs', () => {
    const r = overlayParagraphDiff('A\n\nB', 'A');
    expect(r.removedParagraphs).toEqual(['B']);
  });

  it('handles undefined previous', () => {
    const r = overlayParagraphDiff(undefined, 'A\n\nB');
    expect(r.addedParagraphs.sort()).toEqual(['A', 'B']);
  });
});
