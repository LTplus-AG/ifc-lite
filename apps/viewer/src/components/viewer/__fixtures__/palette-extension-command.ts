/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createBimContext } from '@ifc-lite/sdk';
import type { Bundle, InstalledExtensionRecord, RuntimeRunResult } from '@ifc-lite/extensions';
import { ExtensionHostService } from '@/services/extensions/host';
import { runExtensionCommand, type RunCommandDeps } from '@/services/extensions/host-commands';
import { manifestToContributions } from '../../../../../../packages/extensions/src/host/loader';

/** Real registry + manifest projection + canonical command runner. Only the
 * storage and sandbox boundary are fixtures; activation events share the real
 * host dispatcher, exposing accidental surface pre-fires (#8947).
 */
export class PaletteCommandTestHost extends ExtensionHostService {
  readonly activations: string[] = [];
  readonly executions: string[] = [];
  readonly events: string[] = [];
  readonly records: InstalledExtensionRecord[] = [];
  readonly bundles = new Map<string, Bundle>();
  failure: Error | null = null;

  constructor() {
    super({ sdk: createBimContext({ transport: {
      send: () => Promise.reject(new Error('Unused transport')),
      subscribe: () => () => {}, close: () => {},
    } }) });
    const fire = this.dispatcher.fire.bind(this.dispatcher);
    this.dispatcher.fire = async event => {
      this.events.push(event);
      return fire(event);
    };
  }

  add(owner: string, command = 'paint') {
    const bundle: Bundle = {
      manifest: {
        manifestVersion: 1, id: owner, name: owner, description: 'fixture', version: '1.0.0',
        engines: { ifcLiteSdk: '^1.0.0' }, capabilities: [], activation: [`onCommand:${command}`],
        entry: { commands: { [command]: 'run.js' } },
        contributes: {
          commands: [{ id: command, title: 'Check model', description: 'audit compliance', paletteCategory: 'Quality' }],
          toolbar: [{ command, slot: 'toolbar.right', when: 'selection.count > 0' }],
          keybindings: [{ command, key: 'Shift+G', when: 'selection.count > 0' }],
        },
      },
      files: new Map([['run.js', { path: 'run.js', text: 'function run(ctx) { ctx.bim.record(); }',
        bytes: new TextEncoder().encode('function run(ctx) { ctx.bim.record(); }') }]]),
    };
    this.bundles.set(owner, bundle);
    this.records.push({ id: owner, version: '1.0.0', bundleHash: 'fixture', grantedCapabilities: [],
      enabled: true, installedAt: '2026-01-01T00:00:00Z', source: 'local' });
    this.slotRegistry.register(owner, manifestToContributions(owner, bundle.manifest.contributes));
  }

  override runCommand(command: string, owner: string): Promise<RuntimeRunResult | undefined> {
    let ctx: unknown;
    const deps: RunCommandDeps = {
      sdk: { record: () => { this.executions.push(owner); } },
      storage: { listExtensions: async () => this.records },
      loader: { getBundle: id => this.bundles.get(id) },
      dispatcher: this.dispatcher,
      runtime: {
        deactivate: async () => {},
        activate: async id => {
          this.activations.push(id);
          if (this.failure) throw this.failure;
          return { extensionId: id, activatedAt: '', permissions: {}, grants: [], sandbox: {
            setGlobal: async (_name, value) => { ctx = value; },
            run: async source => {
              const previous = Reflect.get(globalThis, '__ifclite_ctx__');
              Reflect.set(globalThis, '__ifclite_ctx__', ctx);
              try {
                // Execute the real trusted fixture wrapper to prove handler routing.
                // eslint-disable-next-line no-eval
                const value: unknown = await (0, eval)(source);
                return { value, logs: [], durationMs: 0 };
              } finally {
                if (previous === undefined) Reflect.deleteProperty(globalThis, '__ifclite_ctx__');
                else Reflect.set(globalThis, '__ifclite_ctx__', previous);
              }
            },
            dispose: async () => {}, isDisposed: false,
          } };
        },
      },
    };
    return runExtensionCommand(deps, command, owner);
  }
}
