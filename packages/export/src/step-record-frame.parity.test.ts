/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * TypeScript half of the STEP record-frame parity pin (#7682, EXPORT-STEP-1).
 * The Rust half is `rust/export/src/step_record_frame_tests.rs`; both read
 * `rust/export/tests/fixtures/step_record_frame_vectors.json`, so the frame
 * every by-index writer edits through cannot drift between the two writers.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { frameArgs, opensStepRecord, stepRecordFrame, stepRecordHead, withFrameArgs } from './step-record-frame.js';

interface Fixture {
  framed: Array<{ text: string; args: string }>;
  refused: string[];
  unframed: string[];
}

// NOT guarded by existsSync: a missing fixture means the pin is not enforced.
const fixture: Fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../rust/export/tests/fixtures/step_record_frame_vectors.json', import.meta.url)),
    'utf8',
  ),
);

describe('STEP record frame parity with the Rust writer (#7682)', () => {
  it('carries vectors', () => {
    expect(fixture.framed.length).toBeGreaterThan(0);
    expect(fixture.refused.length).toBeGreaterThan(0);
  });

  for (const { text, args } of fixture.framed) {
    it(`frames ${JSON.stringify(text)}`, () => {
      const frame = stepRecordFrame(text);
      expect(frame).not.toBeNull();
      expect(frame && frameArgs(text, frame)).toBe(args);
    });
  }

  for (const text of fixture.refused) {
    it(`refuses ${JSON.stringify(text)}`, () => {
      expect(stepRecordFrame(text)).toBeNull();
    });
  }

  // #7682 review: a line that declares an instance but has no frame opens a
  // record all the same, so an edit on it is reported as unreadable.
  for (const text of fixture.unframed) {
    it(`has no frame but opens a record: ${JSON.stringify(text)}`, () => {
      expect(stepRecordFrame(text)).toBeNull();
      expect(opensStepRecord(text)).toBe(true);
    });
  }

  it('reads the type keyword past trivia', () => {
    const text = '#12 /* =x */ = IFCDOOR\u000b(1);';
    const head = stepRecordHead(text);
    expect(head && text.slice(head.typeStart, head.typeEnd)).toBe('IFCDOOR');
  });

  it('replaces the argument list and keeps every other character', () => {
    const text = '#5 = IFCWALL (\'a\',$) /* c */ ;';
    const frame = stepRecordFrame(text);
    expect(frame && withFrameArgs(text, frame, "'b',#1")).toBe("#5 = IFCWALL ('b',#1) /* c */ ;");
  });
});
