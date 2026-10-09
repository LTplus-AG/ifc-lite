/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `@ifc-lite/ids-agent/testing`: fake models, recorded transcripts and bridge
 * doubles. Used by this package's tests and by the P-08 eval runner, which
 * replays recorded transcripts in CI (no key, no network).
 */

export {
  scriptedTransport,
  recordingTransport,
  replayTransport,
  parseTranscript,
  toolCall,
  turn,
  lastResults,
  type ScriptStep,
  type ScriptedTransport,
  type RecordedTranscript,
} from './transports.js';
export { createFakeModelBridge, createFakeBsddClient, type FakeElement, type FakeBsddRecord } from './doubles.js';
