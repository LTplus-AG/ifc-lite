/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from 'vitest';
import { parseCapability } from '../capability/parse.js';
import {
  ExtensionRuntime,
  type RuntimeSandboxCreateOptions,
  type RuntimeSandboxFactory,
  type RuntimeSandboxHandle,
} from './runtime.js';

function p(raw: string) {
  const r = parseCapability(raw);
  if (!r.ok) throw new Error(r.errors[0].message);
  return r.value;
}

/** Stub factory that records every create() call and supplies disposable handles. */
function stubFactory(): {
  factory: RuntimeSandboxFactory;
  creates: RuntimeSandboxCreateOptions[];
  disposes: string[];
} {
  const creates: RuntimeSandboxCreateOptions[] = [];
  const disposes: string[] = [];
  const factory: RuntimeSandboxFactory = {
    async create(opts) {
      creates.push(opts);
      const handle: RuntimeSandboxHandle = {
        dispose: () => {
          disposes.push(opts.extensionId);
        },
      };
      return handle;
    },
  };
  return { factory, creates, disposes };
}

describe('ExtensionRuntime — activate', () => {
  it('creates a sandbox with permissions derived from grants', async () => {
    const { factory, creates } = stubFactory();
    const runtime = new ExtensionRuntime({ factory });
    const record = await runtime.activate('ext-a', [p('model.read'), p('viewer.colorize')]);
    expect(creates).toHaveLength(1);
    expect(creates[0].extensionId).toBe('ext-a');
    expect(creates[0].permissions.model).toBe(true);
    expect(creates[0].permissions.viewer).toBe(true);
    expect(creates[0].permissions.mutate).toBe(false);
    expect(record.extensionId).toBe('ext-a');
  });

  it('is idempotent', async () => {
    const { factory, creates } = stubFactory();
    const runtime = new ExtensionRuntime({ factory });
    const a = await runtime.activate('ext-a', [p('model.read')]);
    const b = await runtime.activate('ext-a', [p('model.read')]);
    expect(a).toBe(b);
    expect(creates).toHaveLength(1);
  });

  it('stamps activatedAt using the configured clock', async () => {
    const fixed = new Date('2026-05-16T12:00:00.000Z');
    const { factory } = stubFactory();
    const runtime = new ExtensionRuntime({ factory, now: () => fixed });
    const r = await runtime.activate('ext-a', [p('model.read')]);
    expect(r.activatedAt).toBe('2026-05-16T12:00:00.000Z');
  });

  it('passes default limits through to the factory', async () => {
    const { factory, creates } = stubFactory();
    const runtime = new ExtensionRuntime({
      factory,
      defaultLimits: { memoryBytes: 1024, timeoutMs: 500 },
    });
    await runtime.activate('ext-a', []);
    expect(creates[0].limits).toEqual({ memoryBytes: 1024, timeoutMs: 500 });
  });

  it('isActive returns true after activate', async () => {
    const { factory } = stubFactory();
    const runtime = new ExtensionRuntime({ factory });
    expect(runtime.isActive('ext-a')).toBe(false);
    await runtime.activate('ext-a', []);
    expect(runtime.isActive('ext-a')).toBe(true);
  });
});

describe('ExtensionRuntime — deactivate', () => {
  it('disposes the sandbox', async () => {
    const { factory, disposes } = stubFactory();
    const runtime = new ExtensionRuntime({ factory });
    await runtime.activate('ext-a', []);
    await runtime.deactivate('ext-a');
    expect(disposes).toEqual(['ext-a']);
    expect(runtime.isActive('ext-a')).toBe(false);
  });

  it('is a no-op for unknown ids', async () => {
    const { factory, disposes } = stubFactory();
    const runtime = new ExtensionRuntime({ factory });
    await expect(runtime.deactivate('nope')).resolves.toBeUndefined();
    expect(disposes).toEqual([]);
  });

  it('allows re-activation after deactivate', async () => {
    const { factory, creates } = stubFactory();
    const runtime = new ExtensionRuntime({ factory });
    await runtime.activate('ext-a', []);
    await runtime.deactivate('ext-a');
    await runtime.activate('ext-a', []);
    expect(creates).toHaveLength(2);
  });
});

describe('ExtensionRuntime — disposeAll', () => {
  it('disposes every active extension', async () => {
    const { factory, disposes } = stubFactory();
    const runtime = new ExtensionRuntime({ factory });
    await runtime.activate('ext-a', []);
    await runtime.activate('ext-b', []);
    await runtime.activate('ext-c', []);
    await runtime.disposeAll();
    expect(disposes.sort()).toEqual(['ext-a', 'ext-b', 'ext-c']);
    expect(runtime.list()).toEqual([]);
  });
});

describe('ExtensionRuntime — get / list', () => {
  it('get returns the active record', async () => {
    const { factory } = stubFactory();
    const runtime = new ExtensionRuntime({ factory });
    await runtime.activate('ext-a', []);
    expect(runtime.get('ext-a')?.extensionId).toBe('ext-a');
    expect(runtime.get('not-there')).toBeUndefined();
  });

  it('list returns all active ids', async () => {
    const { factory } = stubFactory();
    const runtime = new ExtensionRuntime({ factory });
    await runtime.activate('ext-a', []);
    await runtime.activate('ext-b', []);
    expect(runtime.list().sort()).toEqual(['ext-a', 'ext-b']);
  });
});

describe('ExtensionRuntime — factory errors', () => {
  it('propagates factory errors', async () => {
    const factory: RuntimeSandboxFactory = {
      create: vi.fn().mockRejectedValue(new Error('sandbox boom')),
    };
    const runtime = new ExtensionRuntime({ factory });
    await expect(runtime.activate('ext-a', [])).rejects.toThrow('sandbox boom');
    expect(runtime.isActive('ext-a')).toBe(false);
  });
});
