// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it, vi } from 'vitest';
import { applySkipVoids } from './skip-voids.js';
import { postGeometryWorkerInit } from './geometry-worker-init.js';

describe('gross geometry transport #8875', () => {
  it('rejects unsupported enabled options instead of silently producing net geometry', () => {
    expect(() => applySkipVoids({}, true)).toThrow('setSkipVoids');
    expect(() => applySkipVoids({}, false)).not.toThrow();
  });
  it('sends the cut policy before work, including reset on a reused worker', () => {
    const worker = { postMessage: vi.fn() } as unknown as Worker;
    postGeometryWorkerInit(worker, { skipVoids: true }, null);
    expect(worker.postMessage).toHaveBeenLastCalledWith({ type: 'set-skip-small-cuts', enabled: false, skipVoids: true });
    postGeometryWorkerInit(worker, undefined, null);
    expect(worker.postMessage).toHaveBeenLastCalledWith({ type: 'set-skip-small-cuts', enabled: false, skipVoids: false });
  });
});
