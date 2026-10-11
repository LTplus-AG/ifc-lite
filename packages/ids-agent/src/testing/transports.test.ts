/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The eval hook (P-08): a run can be recorded once and replayed in CI
 * deterministically, without a key. Replaying with the same run id yields
 * the same proposal, byte for byte.
 */

import { describe, expect, it } from 'vitest';
import { doorOps, emptyDoc, schemaContexts } from '../../test/helpers.js';
import { runAgent } from '../runner/loop.js';
import { parseTranscript, recordingTransport, replayTransport, scriptedTransport, toolCall, turn } from './transports.js';

describe('recorded transcripts', () => {
  it('record a run, then replay it to the identical proposal', async () => {
    const { gate, lint } = await schemaContexts();
    const runId = '0190e2c4-5f6a-7b8c-9d0e-1f2a3b4c5d6e';
    const live = scriptedTransport([
      turn([toolCall('ids_apply_ops', { ops: doorOps() }, 'call-a')]),
      turn([{ type: 'text', text: 'One specification.' }]),
    ]);
    const recorder = recordingTransport(live.transport);
    const first = await runAgent({ transport: recorder.transport, mode: 'draft', request: 'r', doc: emptyDoc(), gate, lint, runId });
    const file = JSON.parse(JSON.stringify(recorder.transcript('scripted'))) as unknown;
    const transcript = parseTranscript(file);
    expect(transcript.turns).toHaveLength(2);

    const second = await runAgent({ transport: replayTransport(transcript), mode: 'draft', request: 'r', doc: emptyDoc(), gate, lint, runId });
    expect(second.proposal.batches).toEqual(first.proposal.batches);
    expect(second.proposal.draft.ids).toEqual(first.proposal.draft.ids);
    expect(second.status).toBe('completed');
  });

  it('refuse a file that is not a transcript and fail when exhausted', async () => {
    expect(() => parseTranscript({ format: 'other' })).toThrow(/Not an ids-agent transcript/);
    const replay = replayTransport({ format: 'ids-agent-transcript', version: 1, model: 'm', turns: [] });
    await expect(replay({ model: 'm', system: '', messages: [], tools: [], maxOutputTokens: 1, signal: new AbortController().signal, onText: () => undefined, onThinking: () => undefined }))
      .rejects.toThrow(/exhausted/);
  });
});
