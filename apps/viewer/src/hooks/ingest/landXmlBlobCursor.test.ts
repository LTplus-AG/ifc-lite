/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  LANDXML_BLOB_CHUNK_BYTES, LANDXML_CURSOR_CREDIT_BYTES,
  parseLandXmlSourceBlobWithApi, streamLandXmlSourceBlobWithApi, type LandXmlCursorApi,
} from './landXmlBlobCursor.js';

const encode = (value: unknown): number[] => Array.from(new TextEncoder().encode(JSON.stringify(value)));

describe('LandXML Blob cursor driver (#5050)', () => {
  it('feeds bounded Blob slices, drains exact credit, and frees a malformed cursor tail', async () => {
    const inputs: number[] = [];
    const credits: number[] = [];
    let aborted = 0;
    let freed = 0;
    let pending = false;
    let advanced = 0;
    const api: LandXmlCursorApi = {
      createLandXmlTinStreamSession: () => ({
        advanceChunk: (data) => { inputs.push(data.byteLength); pending = true; advanced++; },
        drain: (credit) => {
          credits.push(credit);
          pending = false;
          return advanced === 1 ? [{
            kind: 'surface', source_id: 's', component: 'start', sequence: 0, continued: false,
            payload_utf8: encode({ ordinal: 1, source_path: 's', properties: {}, definition_properties: {}, name: 's', kind: 'tin', render_state: 'rendered', topology_origin: 'authored_faces', terrain_diagnostic: null, hidden_face_count: 0 }),
          }] : [];
        },
        finishCursor: () => { pending = true; },
        outputPending: () => pending,
        abort: () => { aborted++; },
        free: () => { freed++; },
      }),
    };
    const blob = new Blob([new Uint8Array(LANDXML_BLOB_CHUNK_BYTES + 3)]);
    await assert.rejects(parseLandXmlSourceBlobWithApi(api, blob), /ended without metadata document/);
    assert.deepEqual(inputs, [LANDXML_BLOB_CHUNK_BYTES, 3]);
    assert.ok(credits.every((credit) => credit === LANDXML_CURSOR_CREDIT_BYTES));
    assert.equal(aborted, 1);
    assert.equal(freed, 1);
  });

  it('relays credited events without constructing a second source document (#5050)', async () => {
    let pending = false;
    let drained = 0;
    const kinds: string[] = [];
    const api: LandXmlCursorApi = {
      createLandXmlTinStreamSession: () => ({
        advanceChunk: () => { pending = true; },
        drain: () => {
          pending = false;
          drained++;
          return drained === 1
            ? [{ kind: 'header', units: { linear_scale_to_meters: 1, elevation_scale_to_meters: 1 } }]
            : [
              { kind: 'metadata', metadata_kind: 'header', terrain: {}, pipe_networks: {} },
              { kind: 'metadata', metadata_kind: 'end', has_pipe_networks: false },
            ];
        },
        finishCursor: () => { pending = true; },
        outputPending: () => pending,
        abort: () => {},
        free: () => {},
      }),
    };
    await streamLandXmlSourceBlobWithApi(api, new Blob(['x']), {
      onEvent: (event) => { kinds.push((event as { kind: string }).kind); },
    });
    assert.deepEqual(kinds, ['header', 'metadata', 'metadata']);
  });
});

/**
 * #5175 review: both cursor entry points construct their own stream session,
 * so an `assumedLinearUnit` honoured by only one of them is an override a
 * caller of the other silently cannot use — they would keep getting LXML009
 * while having asked for a unit.
 */
describe('LandXML cursor forwards the assumed linear unit (#5175)', () => {
  function recordingApi(seen: Array<unknown>): LandXmlCursorApi {
    return {
      createLandXmlTinStreamSession: (_maxBytes: number, options?: unknown) => {
        seen.push(options);
        return {
          advanceChunk: () => {},
          drain: () => [],
          finishCursor: () => {},
          outputPending: () => false,
          abort: () => {},
          free: () => {},
        };
      },
    } as unknown as LandXmlCursorApi;
  }

  for (const [name, run] of [
    ['streamLandXmlSourceBlobWithApi', streamLandXmlSourceBlobWithApi],
    ['parseLandXmlSourceBlobWithApi', parseLandXmlSourceBlobWithApi],
  ] as const) {
    it(`${name} passes the option through`, async () => {
      const seen: Array<unknown> = [];
      await run(recordingApi(seen), new Blob(['<LandXML/>']), { assumedLinearUnit: 'foot' }).catch(() => {});
      assert.deepEqual(seen, [{ assumedLinearUnit: 'foot' }], `${name} must forward assumedLinearUnit`);
    });

    it(`${name} passes undefined when no unit was supplied`, async () => {
      const seen: Array<unknown> = [];
      await run(recordingApi(seen), new Blob(['<LandXML/>']), {}).catch(() => {});
      assert.deepEqual(seen, [undefined], `${name} must not fabricate an options object`);
    });
  }
});
