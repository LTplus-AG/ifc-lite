/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import {
  EMBED_SOURCE,
  PROTOCOL_VERSION,
  createEvent,
  createResponse,
  createCommand,
  isEmbedMessage,
} from '../src/index.js';

describe('protocol constants', () => {
  // These two strings are the wire contract between the embed viewer and every
  // published SDK version. Changing either silently breaks every deployed embed,
  // so pin the literal values, not just their types.
  it('pins the message discriminator', () => {
    expect(EMBED_SOURCE).toBe('ifc-lite-embed');
  });

  it('pins the protocol version', () => {
    expect(PROTOCOL_VERSION).toBe('1.0');
  });
});

describe('createEvent', () => {
  it('stamps source, version, type and data', () => {
    const msg = createEvent('MODEL_LOADING', { progress: 0.5, phase: 'geometry' });
    expect(msg).toEqual({
      source: 'ifc-lite-embed',
      version: '1.0',
      type: 'MODEL_LOADING',
      data: { progress: 0.5, phase: 'geometry' },
    });
  });

  it('carries the exact type string it was given', () => {
    expect(createEvent('READY', { version: '1.0' }).type).toBe('READY');
    expect(createEvent('SECTION_CHANGED', { axis: 'down', position: 1, enabled: true }).type)
      .toBe('SECTION_CHANGED');
  });

  it('leaves data undefined when omitted, and sets no requestId/responseId', () => {
    const msg = createEvent('INIT_ACK');
    expect(msg.data).toBeUndefined();
    expect(msg.requestId).toBeUndefined();
    expect(msg.responseId).toBeUndefined();
  });

  it('preserves the payload object identity (no cloning)', () => {
    const data = { azimuth: 1, elevation: 2 };
    expect(createEvent('CAMERA_CHANGED', data).data).toBe(data);
  });
});

describe('createResponse', () => {
  it('uses the RESPONSE type and echoes the responseId', () => {
    const msg = createResponse('req-42', { dataUrl: 'data:,' });
    expect(msg.type).toBe('RESPONSE');
    expect(msg.responseId).toBe('req-42');
    expect(msg.data).toEqual({ dataUrl: 'data:,' });
    expect(msg.error).toBeUndefined();
    // A response must never be mistaken for a request by the correlation logic.
    expect(msg.requestId).toBeUndefined();
  });

  it('carries an error payload through unchanged', () => {
    const err = { code: 'LOAD_FAILED', message: 'boom' };
    const msg = createResponse('req-1', undefined, err);
    expect(msg.error).toEqual(err);
    expect(msg.data).toBeUndefined();
  });

  it('stamps source and version like every other envelope', () => {
    const msg = createResponse('req-1');
    expect(msg.source).toBe(EMBED_SOURCE);
    expect(msg.version).toBe(PROTOCOL_VERSION);
  });
});

describe('createCommand', () => {
  it('stamps type, data and requestId', () => {
    const msg = createCommand('LOAD_MODEL', { url: 'https://example.test/a.ifc' }, 'req-7');
    expect(msg).toEqual({
      source: 'ifc-lite-embed',
      version: '1.0',
      type: 'LOAD_MODEL',
      requestId: 'req-7',
      data: { url: 'https://example.test/a.ifc' },
    });
  });

  it('omits requestId for fire-and-forget commands, and never sets responseId', () => {
    const msg = createCommand('SHOW_ALL');
    expect(msg.requestId).toBeUndefined();
    expect(msg.responseId).toBeUndefined();
    expect(msg.type).toBe('SHOW_ALL');
  });
});

describe('isEmbedMessage', () => {
  it('accepts an envelope carrying the embed discriminator', () => {
    expect(isEmbedMessage({ source: EMBED_SOURCE, version: '1.0', type: 'READY' })).toBe(true);
  });

  it('accepts a bare object whose only field is the discriminator', () => {
    expect(isEmbedMessage({ source: 'ifc-lite-embed' })).toBe(true);
  });

  it('rejects null and undefined', () => {
    expect(isEmbedMessage(null)).toBe(false);
    expect(isEmbedMessage(undefined)).toBe(false);
  });

  it('rejects non-objects', () => {
    expect(isEmbedMessage('ifc-lite-embed')).toBe(false);
    expect(isEmbedMessage(42)).toBe(false);
    expect(isEmbedMessage(true)).toBe(false);
  });

  it('rejects an object with no source field', () => {
    expect(isEmbedMessage({ type: 'READY' })).toBe(false);
    expect(isEmbedMessage({})).toBe(false);
  });

  it('rejects a foreign source, including near-misses', () => {
    expect(isEmbedMessage({ source: 'react-devtools-bridge' })).toBe(false);
    expect(isEmbedMessage({ source: 'ifc-lite-embed-evil' })).toBe(false);
    expect(isEmbedMessage({ source: 'IFC-LITE-EMBED' })).toBe(false);
    expect(isEmbedMessage({ source: '' })).toBe(false);
    expect(isEmbedMessage({ source: undefined })).toBe(false);
  });

  it('rejects an array, which is an object but never a valid envelope', () => {
    expect(isEmbedMessage([])).toBe(false);
    expect(isEmbedMessage(['ifc-lite-embed'])).toBe(false);
  });

  it('accepts a source inherited from the prototype chain', () => {
    // `in` walks the prototype chain; this documents the current behaviour so a
    // switch to a hasOwnProperty check is a deliberate, visible change.
    const proto = { source: EMBED_SOURCE };
    expect(isEmbedMessage(Object.create(proto))).toBe(true);
  });

  it('narrows the type so envelope fields are readable', () => {
    const data: unknown = createEvent('READY', { version: '1.0' });
    if (!isEmbedMessage(data)) throw new Error('expected an embed message');
    expect(data.type).toBe('READY');
  });
});
