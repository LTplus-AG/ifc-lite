/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setFrameLeadCommands, setOpaqueVisibilityCommands, takeOpaqueVisibilityCommands } from './opaque-visibility-commands.js';

// #11373: an orthographic frame's GPU instance cull must reach the queue before the geometric-depth prepass that reads it.
describe('frame command hand-off', () => {
  it('submits the lead buffer, then the opaque-visibility prepass, then nothing twice', () => {
    const encoder = {} as GPUCommandEncoder;
    const lead = { label: 'instance-cull' } as GPUCommandBuffer, prepass = { label: 'opaque-visibility' } as GPUCommandBuffer;
    setOpaqueVisibilityCommands(encoder, prepass);
    setFrameLeadCommands(encoder, lead);
    assert.deepEqual(takeOpaqueVisibilityCommands(encoder), [lead, prepass]);
    assert.deepEqual(takeOpaqueVisibilityCommands(encoder), []);
  });

  it('hands off a lead buffer alone (orthographic frame without a prepass)', () => {
    const encoder = {} as GPUCommandEncoder;
    const lead = {} as GPUCommandBuffer;
    setFrameLeadCommands(encoder, lead);
    assert.deepEqual(takeOpaqueVisibilityCommands(encoder), [lead]);
  });
});
