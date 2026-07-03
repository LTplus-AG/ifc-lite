/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PERMISSIONS } from '../../sandbox/src/types.js';
import { SandboxNamespace, type SandboxPermissions, type ScriptResult } from './namespaces/sandbox.js';

const sandboxModuleMock = vi.hoisted(() => ({
  createSandbox: vi.fn(),
  transpileTypeScript: vi.fn(async (code: string) => code),
  DEFAULT_PERMISSIONS: {
    query: true,
    mutate: false,
    viewer: true,
    export: true,
    model: true,
    lens: true,
    files: true,
  },
  DEFAULT_LIMITS: {
    timeoutMs: 30_000,
    memoryBytes: 64 * 1024 * 1024,
    maxStackBytes: 512 * 1024,
  },
  NAMESPACE_SCHEMAS: [],
}));

vi.mock('@ifc-lite/sandbox', () => sandboxModuleMock);

describe('SandboxNamespace parity', () => {
  beforeEach(() => {
    sandboxModuleMock.createSandbox.mockReset();
    sandboxModuleMock.transpileTypeScript.mockClear();
  });

  it('accepts runtime default permissions including files access', () => {
    const permissions: SandboxPermissions = DEFAULT_PERMISSIONS;
    expect(permissions.viewer).toBe(true);
    expect(permissions.export).toBe(true);
    expect(permissions.files).toBe(true);
  });

  it('serializes eval calls on a single sandbox instance', async () => {
    let resolveFirstEval: ((value: ScriptResult) => void) | null = null;
    const evalMock = vi.fn((script: string) => new Promise<ScriptResult>((resolve) => {
      if (script === 'first') {
        resolveFirstEval = resolve;
        return;
      }
      resolve({ value: script, logs: [], durationMs: 0 });
    }));

    sandboxModuleMock.createSandbox.mockResolvedValue({
      eval: evalMock,
      dispose: vi.fn(),
    });

    const sandbox = new SandboxNamespace({});
    const firstEval = sandbox.eval('first');
    await vi.waitFor(() => {
      expect(sandboxModuleMock.createSandbox).toHaveBeenCalledTimes(1);
      expect(evalMock).toHaveBeenCalledTimes(1);
    });

    const secondEval = sandbox.eval('second');
    expect(evalMock).toHaveBeenCalledTimes(1);

    resolveFirstEval?.({ value: 'first', logs: [], durationMs: 0 });

    await expect(firstEval).resolves.toEqual({ value: 'first', logs: [], durationMs: 0 });
    await vi.waitFor(() => {
      expect(evalMock).toHaveBeenCalledTimes(2);
    });
    await expect(secondEval).resolves.toEqual({ value: 'second', logs: [], durationMs: 0 });
  });

  it('disposes the previous sandbox before replacing it with create()', async () => {
    const firstDispose = vi.fn();
    const secondDispose = vi.fn();

    sandboxModuleMock.createSandbox
      .mockResolvedValueOnce({ eval: vi.fn(), dispose: firstDispose })
      .mockResolvedValueOnce({ eval: vi.fn(), dispose: secondDispose });

    const sandbox = new SandboxNamespace({});
    await sandbox.create();
    await sandbox.create();

    await vi.waitFor(() => {
      expect(firstDispose).toHaveBeenCalledTimes(1);
    });
    expect(secondDispose).not.toHaveBeenCalled();
  });

  it('waits for eval to finish before disposing the active sandbox', async () => {
    let resolveEval: ((value: ScriptResult) => void) | null = null;
    const evalMock = vi.fn(() => new Promise<ScriptResult>((resolve) => {
      resolveEval = resolve;
    }));
    const disposeSpy = vi.fn();

    sandboxModuleMock.createSandbox.mockResolvedValue({
      eval: evalMock,
      dispose: disposeSpy,
    });

    const sandbox = new SandboxNamespace({});
    const evalPromise = sandbox.eval('pending');
    await vi.waitFor(() => {
      expect(evalMock).toHaveBeenCalledTimes(1);
    });

    const disposePromise = sandbox.dispose();
    expect(disposeSpy).not.toHaveBeenCalled();

    resolveEval?.({ value: 'done', logs: [], durationMs: 0 });

    await evalPromise;
    await disposePromise;

    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });
});
