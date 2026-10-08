/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Revisions, sign-off and hash chain (IDS-107). The acceptance test is the
 * tamper test: every kind of edit to a stored log is detected by
 * `verifyRevisionLog`, and an untouched log verifies.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { counterIds } from '../../test/corpus.js';
import { corpusDocument } from '../../test/mutate.js';
import { seeded } from '../../test/op-gen.js';
import type { StudioDocument } from '../document/types.js';
import type { PrimitiveOp, StudioOp } from '../ops/types.js';
import { apply } from '../reducer/apply.js';
import {
  checkoutRevision,
  commitRevision,
  contentHash,
  createRevisionLog,
  isReleasedContent,
  RevisionError,
  signOff,
  type RevisionLog,
} from './revision.js';
import { sha256Hex } from './sha256.js';
import { verifyRevisionLog } from './verify.js';
import { revisionTimeline } from './view.js';

const ids = counterIds(0x7e4);
const op = <K extends PrimitiveOp['kind']>(kind: K, payload: Extract<PrimitiveOp, { kind: K }>['payload']): StudioOp =>
  ({ kind, opId: ids(), payload }) as StudioOp;

function history(): { log: RevisionLog; docs: StudioDocument[] } {
  const v1 = corpusDocument(2, 3);
  const spec = v1.ids.specifications[0];
  const v2 = apply(v1, [op('spec.set', { specId: spec.id, field: 'description', value: 'Doors need a fire rating' })]).doc;
  const v3 = apply(v2, [op('doc.setInfo', { field: 'version', value: '1.0' })]).doc;
  let log = createRevisionLog(v1.docId);
  log = commitRevision(log, v1, { author: 'a@example.com', at: '2026-10-01T09:00:00Z', message: 'first draft', revId: ids() }).log;
  log = commitRevision(log, v2, { author: 'b@example.com', at: '2026-10-02T09:00:00Z', label: 'review', revId: ids() }).log;
  log = commitRevision(log, v3, { author: 'a@example.com', at: '2026-10-03T09:00:00Z', label: 'released', message: 'v1.0', revId: ids() }).log;
  log = signOff(log, log.revisions[2].revId, { by: 'Lead engineer', role: 'BIM manager', at: '2026-10-03T10:00:00Z', statement: 'Approved for tender' }).log;
  log = signOff(log, log.revisions[2].revId, { by: 'Client rep', at: '2026-10-04T10:00:00Z', statement: 'Accepted' }).log;
  return { log, docs: [v1, v2, v3] };
}

/** Deep copy, so a tamper never touches the original. */
const clone = (log: RevisionLog): RevisionLog => JSON.parse(JSON.stringify(log)) as RevisionLog;

describe('sha256Hex', () => {
  it('matches node:crypto on random and Unicode input', () => {
    const rng = seeded(0x5a);
    const samples = ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'Brandschutz ÄÖÜ – 防火 🔥'];
    for (let i = 0; i < 200; i++) {
      samples.push(Array.from({ length: Math.floor(rng() * 300) }, () => String.fromCharCode(32 + Math.floor(rng() * 2000))).join(''));
    }
    for (const s of samples) expect(sha256Hex(s)).toBe(createHash('sha256').update(s, 'utf8').digest('hex'));
  });
});

describe('revision log', () => {
  it('verifies an untouched log and round-trips through JSON', () => {
    const { log } = history();
    expect(verifyRevisionLog(log)).toEqual({ ok: true, problems: [] });
    expect(verifyRevisionLog(clone(log)).ok).toBe(true);
  });

  it('detects every kind of tampering (tamper test)', () => {
    const { log, docs } = history();
    const tampers: [string, (l: RevisionLog) => void, string][] = [
      ['edit a message', (l) => void (l.revisions[0].message = 'nothing to see'), 'REV-HASH-001'],
      ['backdate a revision', (l) => void (l.revisions[1].at = '2020-01-01T00:00:00Z'), 'REV-HASH-001'],
      ['relabel a draft as released', (l) => void (l.revisions[0].label = 'released'), 'REV-HASH-001'],
      ['edit committed content', (l) => void (l.revisions[1].snapshot.ids.specifications[0].name = 'Other'), 'REV-CONTENT-001'],
      ['swap in another document state', (l) => void (l.revisions[2].snapshot = docs[0]), 'REV-CONTENT-001'],
      ['drop a revision from the chain', (l) => void l.revisions.splice(1, 1), 'REV-CHAIN-001'],
      ['reorder revisions', (l) => void l.revisions.reverse(), 'REV-CHAIN-001'],
      ['re-hash an edited record (chain still breaks)', (l) => {
        l.revisions[0].message = 'rewritten';
        l.revisions[0].hash = 'f'.repeat(64);
      }, 'REV-CHAIN-001'],
      ['edit a sign-off statement', (l) => void (l.signOffs[0].statement = 'Rejected'), 'SIGN-HASH-001'],
      ['move a sign-off to another revision', (l) => void (l.signOffs[1].revId = l.revisions[1].revId), 'SIGN-REV-001'],
      ['remove the first sign-off', (l) => void l.signOffs.shift(), 'SIGN-CHAIN-001'],
      ['reorder sign-offs', (l) => void l.signOffs.reverse(), 'SIGN-CHAIN-001'],
    ];
    for (const [what, tamper, code] of tampers) {
      const copy = clone(log);
      tamper(copy);
      const result = verifyRevisionLog(copy);
      expect(result.ok, what).toBe(false);
      expect(result.problems.map((p) => p.code), what).toContain(code);
    }
  });

  it('keeps released revisions read-only: edits on top branch to a draft', () => {
    const { log, docs } = history();
    const released = log.revisions[2];
    expect(isReleasedContent(log, docs[2])).toBe(true);
    const edited = apply(checkoutRevision(log, released.revId), [op('doc.setInfo', { field: 'version', value: '1.1' })]).doc;
    expect(isReleasedContent(log, edited)).toBe(false);
    expect(() => commitRevision(log, edited, { author: 'a@example.com', label: 'review' })).toThrow(RevisionError);
    const next = commitRevision(log, edited, { author: 'a@example.com' });
    expect(next.revision).toMatchObject({ label: 'draft', parentRevId: released.revId, parentHash: released.hash });
    expect(verifyRevisionLog(next.log).ok).toBe(true);
    // Promoting unchanged content to released stays allowed.
    expect(() => commitRevision(log, docs[2], { author: 'a@example.com', label: 'released' })).not.toThrow();
  });

  it('signs off only revisions in review or released', () => {
    const { log } = history();
    expect(() => signOff(log, log.revisions[0].revId, { by: 'x', statement: 'ok' })).toThrow(/review or released/);
  });

  it('hashes normative content only (node ids and comments excluded)', () => {
    const { docs } = history();
    const withComment: StudioDocument = { ...docs[0], meta: { ...docs[0].meta, comments: { x: [] } } };
    expect(contentHash(withComment)).toBe(contentHash(docs[0]));
    expect(contentHash(docs[1])).not.toBe(contentHash(docs[0]));
  });

  it('builds a timeline with plain-language changes and verification state', () => {
    const { log } = history();
    const timeline = revisionTimeline(log);
    expect(timeline.verified).toBe(true);
    expect(timeline.entries.map((e) => e.label)).toEqual(['released', 'review', 'draft']);
    expect(timeline.entries[0]).toMatchObject({ isHead: true, readOnly: true, changes: ['Version set to "1.0"'] });
    expect(timeline.entries[0].signOffs.map((s) => s.by)).toEqual(['Lead engineer', 'Client rep']);
    expect(timeline.entries[1].changes[0]).toContain('Doors need a fire rating');
    const broken = clone(log);
    broken.revisions[0].author = 'mallory@example.com';
    expect(revisionTimeline(broken).entries[2].problems.map((p) => p.code)).toEqual(['REV-HASH-001']);
  });
});
