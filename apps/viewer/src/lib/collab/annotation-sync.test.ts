/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `attachAnnotationInbound` reconciles the room's annotations Y.Map into the
 * local slice. Two guards carry the real risk here, both matching the sweep's
 * known failure shape (a guard whose "do nothing" branch is never exercised,
 * and a delete/absence handled as a value):
 *
 *   - `if (isLocalTxn) return` — our own mirror writes must not re-enter the
 *     slice as if they were a peer's, or every local edit would echo.
 *   - `if (a.remote && !remote.has(id)) ctx.removeRemote(id)` — only a
 *     PEER-authored pin missing from the room is treated as deleted. Drop the
 *     `a.remote &&` half and a locally-authored pin that hasn't round-tripped
 *     into the room's Y.Doc yet (the documented "brief CRDT lag") gets wiped
 *     out from under the author while they're still looking at it.
 *
 * These tests drive the real `Y.Doc` (`createCollabDoc`) and the real
 * annotation CRDT helpers (`createAnnotation` / `deleteAnnotation` /
 * `iterAnnotations`), not a stub — so the guard under test is the one
 * `collabSlice` actually wires.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import {
  createCollabDoc,
  createAnnotation,
  deleteAnnotation,
  iterAnnotations,
  annotationsMap,
} from '@ifc-lite/collab';
import type { CollabSession } from '@ifc-lite/collab';
import type { Annotation } from '@/store/slices/annotationsSlice';
import {
  attachAnnotationInbound,
  annotationToCrdtFields,
  type AnnotationDocApi,
  type CrdtAnnotationRecord,
} from './annotation-sync.js';

/**
 * `yjs` is a transitive dependency (via `@ifc-lite/collab`), not a direct
 * dependency of the viewer package — same resolution trick as
 * `mutation-bridge.test.ts`: load the exact ESM build collab itself uses
 * (mixing it with the CJS build throws "Unexpected content type" on
 * `instanceof` checks), so a fork of `doc` and `Y.applyUpdate` can simulate a
 * genuine peer write (`transaction.local === false`), which a same-doc
 * `doc.transact()` never produces regardless of what origin is passed.
 */
const collabCjsResolve = createRequire(import.meta.resolve('@ifc-lite/collab'));
const yjsEsmPath = collabCjsResolve.resolve('yjs').replace(/dist[\\/]yjs\.cjs$/, 'dist/yjs.mjs');
const Y: {
  applyUpdate(doc: YDoc, update: Uint8Array): void;
  encodeStateAsUpdate(doc: YDoc, encodedTargetStateVector?: Uint8Array): Uint8Array;
  encodeStateVector(doc: YDoc): Uint8Array;
  Doc: new () => YDoc;
} = await import(pathToFileURL(yjsEsmPath).href);
type YDoc = ReturnType<typeof createCollabDoc>;

/**
 * Simulate a peer's edit landing on `doc`: fork a second Y.Doc from `doc`'s
 * current state, mutate the fork, then apply the diff back onto `doc` — the
 * fork is a distinct principal with its own writes, not this client echoing
 * itself.
 */
function applyAsRemoteEdit(doc: YDoc, mutate: (remote: YDoc) => void): void {
  const remote = new Y.Doc();
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
  mutate(remote);
  const diff = Y.encodeStateAsUpdate(remote, Y.encodeStateVector(doc));
  Y.applyUpdate(doc, diff);
}

const api: AnnotationDocApi = {
  annotationsMap: (doc) => annotationsMap(doc) as unknown as {
    observeDeep(fn: (events: unknown, txn: { local?: boolean }) => void): void;
    unobserveDeep(fn: (events: unknown, txn: { local?: boolean }) => void): void;
  },
  createAnnotation: (doc, id, fields) => createAnnotation(doc, id, fields),
  deleteAnnotation: (doc, id) => deleteAnnotation(doc, id),
  iterAnnotations: (doc) => iterAnnotations(doc) as IterableIterator<CrdtAnnotationRecord>,
};

function fakeSession(doc: ReturnType<typeof createCollabDoc>): CollabSession {
  return { doc, transact: (fn: () => void) => doc.transact(fn) } as unknown as CollabSession;
}

function localAnnotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: 'pin-1',
    position: { x: 0, y: 0, z: 0 },
    note: 'hello',
    entityExpressId: null,
    modelId: null,
    createdAt: 1,
    updatedAt: 1,
    authorId: 'me',
    authorName: 'Me',
    authorColor: '#111',
    remote: false,
    ...overrides,
  };
}

/** A recorder standing in for the slice's `upsertRemote` / `removeRemote`. */
function makeCtx(myId: string, initialLocal: Annotation[] = []) {
  const local = new Map<string, Annotation>(initialLocal.map((a) => [a.id, a]));
  const upserts: Annotation[] = [];
  const removes: string[] = [];
  return {
    ctx: {
      myId: () => myId,
      getLocal: () => local,
      upsertRemote: (a: Annotation) => {
        upserts.push(a);
        local.set(a.id, a);
      },
      removeRemote: (id: string) => {
        removes.push(id);
        local.delete(id);
      },
    },
    local,
    upserts,
    removes,
  };
}

describe('attachAnnotationInbound — local-echo guard', () => {
  it('does not treat our own mirror write as an inbound change', () => {
    const doc = createCollabDoc();
    const session = fakeSession(doc);
    const { ctx, upserts, removes } = makeCtx('me');

    const teardown = attachAnnotationInbound(session, api, ctx);
    // Our own mirror write: session.transact(...) -> txn.local === true.
    session.transact(() =>
      api.createAnnotation(doc, 'pin-1', annotationToCrdtFields(localAnnotation())),
    );

    assert.equal(upserts.length, 0, 'a local txn must not re-enter the slice as an inbound change');
    assert.equal(removes.length, 0);
    teardown();
  });
});

describe('attachAnnotationInbound — delete vs. absence, two principals', () => {
  it('removes a pin only when its PEER author deleted it from the room', () => {
    const doc = createCollabDoc();
    const session = fakeSession(doc);
    const peerPin = localAnnotation({ id: 'peer-pin', authorId: 'peer', remote: true });
    const { ctx, removes } = makeCtx('me', [peerPin]);

    // Seed the room with the pin as the peer originally created it, via a
    // genuine cross-doc write, so its deletion below is a real peer write too.
    applyAsRemoteEdit(doc, (remote) => createAnnotation(remote, 'peer-pin', annotationToCrdtFields(peerPin)));

    const teardown = attachAnnotationInbound(session, api, ctx);
    applyAsRemoteEdit(doc, (remote) => deleteAnnotation(remote, 'peer-pin'));

    assert.deepEqual(removes, ['peer-pin'], 'a peer-authored pin missing from the room is removed');
    teardown();
  });

  it('does NOT delete a pin I authored that has not round-tripped into the room yet', () => {
    // This is the guard's whole reason to exist: a pin I just created is in my
    // local map (optimistic) but the room's Y.Doc genuinely has nothing else
    // yet (a brief CRDT lag before my own mirror write lands). An unrelated
    // inbound change must not wipe it out from under me.
    const doc = createCollabDoc();
    const session = fakeSession(doc);
    const myPin = localAnnotation({ id: 'my-pin', authorId: 'me', remote: false });
    const { ctx, removes } = makeCtx('me', [myPin]);

    const teardown = attachAnnotationInbound(session, api, ctx);
    // Some unrelated remote activity ticks the map (e.g. a peer's own pin
    // arriving) without ever containing 'my-pin'.
    applyAsRemoteEdit(doc, (remote) =>
      createAnnotation(remote, 'peer-pin', annotationToCrdtFields(localAnnotation({ id: 'peer-pin', authorId: 'peer' }))),
    );

    assert.deepEqual(removes, [], 'a not-yet-synced, locally-authored pin must survive the lag');
    teardown();
  });

  it('overwrites MY pin when a peer (not the owner) edits it — ownership stays mine, content is theirs', () => {
    const doc = createCollabDoc();
    const session = fakeSession(doc);
    const original = localAnnotation({ id: 'my-pin', authorId: 'me', note: 'original', updatedAt: 1, remote: false });
    const { ctx, upserts, local } = makeCtx('me', [original]);

    const teardown = attachAnnotationInbound(session, api, ctx);
    // Seed the room with the pin as it already is, then have a PEER principal
    // edit it (actor is not the owner: authorId stays 'me', the edit is
    // someone else's write, via a genuine cross-doc update).
    applyAsRemoteEdit(doc, (remote) => createAnnotation(remote, 'my-pin', annotationToCrdtFields(original)));
    applyAsRemoteEdit(doc, (remote) => {
      const fields = annotationToCrdtFields({ ...original, note: 'edited by peer', updatedAt: 2 });
      createAnnotation(remote, 'my-pin', fields);
    });

    assert.ok(upserts.some((a) => a.note === 'edited by peer'), 'the room version wins once it differs');
    assert.equal(local.get('my-pin')?.remote, false, 'ownership is by author, not by who wrote the change');
    teardown();
  });

  it('does not churn the slice on a true no-op (same note, same updatedAt)', () => {
    const doc = createCollabDoc();
    const session = fakeSession(doc);
    const pin = localAnnotation({ id: 'my-pin', authorId: 'peer', remote: true, note: 'x', updatedAt: 5 });
    // The room already has this exact pin (a prior sync), and the local slice
    // already mirrors it — so attach's initial pull is itself a no-op too.
    createAnnotation(doc, 'my-pin', annotationToCrdtFields(pin));
    const { ctx, upserts } = makeCtx('me', [pin]);

    const teardown = attachAnnotationInbound(session, api, ctx);
    assert.equal(upserts.length, 0, 'initial pull of an already-mirrored pin is a no-op');
    // A peer re-sets the identical fields again — same note/updatedAt.
    applyAsRemoteEdit(doc, (remote) => createAnnotation(remote, 'my-pin', annotationToCrdtFields(pin)));

    assert.equal(upserts.length, 0, 'identical note+updatedAt is a no-op, not an upsert');
    teardown();
  });

  it('initial pull reflects pins already in the room for a late joiner', () => {
    const doc = createCollabDoc();
    const session = fakeSession(doc);
    createAnnotation(doc, 'existing', annotationToCrdtFields(localAnnotation({ id: 'existing', authorId: 'peer' })));
    const { ctx, upserts } = makeCtx('me');

    const teardown = attachAnnotationInbound(session, api, ctx);
    assert.equal(upserts.length, 1, 'attach does an initial pull, not just future changes');
    assert.equal(upserts[0].id, 'existing');
    teardown();
  });
});
