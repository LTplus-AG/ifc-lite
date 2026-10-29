/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `@types/n3` >= 1.26.5 types the `Writer.end` result as `string | undefined`
 * (#8231). A writer that reports no value must still resolve to a string, so
 * every serializer here resolves '' rather than `undefined`.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('n3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('n3')>();
  const Writer = class extends actual.Writer {};
  (Writer.prototype as unknown as { end: (done: (error: null, value: undefined) => void) => void }).end =
    (done) => done(null, undefined);
  return { ...actual, Writer };
});

import { parseGraph } from './graph-import.js';
import { shapesTurtle, vocabularyTurtle } from './profile-artifacts.js';

describe('N3 Writer.end without a value', () => {
  it('parseGraph resolves an empty graph string', async () => {
    const { graph } = await parseGraph('', { format: 'text/turtle' });
    expect(graph).toBe('');
  });

  it('profile artifacts resolve empty strings', async () => {
    expect(await shapesTurtle()).toBe('');
    expect(await vocabularyTurtle()).toBe('');
  });
});
