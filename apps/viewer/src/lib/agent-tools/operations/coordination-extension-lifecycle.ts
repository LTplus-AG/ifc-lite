/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { coordinationExtensions } from '@/services/coordination-hosts';
import { useViewerStore } from '@/store';
import { coordination, idSchema, textSchema } from './coordination-common';
export const coordinationExtensionLifecycleOperations = [
  coordination('extensions.requestInstall', 'Validate exact bundle bytes and stage the native capability review. Returns waiting-for-capability-review; never installs, activates or grants a capability implicitly.', ['configuration'], textSchema, async (i, c) => {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(i.value)) throw new Error('Expected base64 .iflx bundle bytes.');
    const bytes = Uint8Array.from(atob(i.value), character => character.charCodeAt(0)), host = coordinationExtensions();
    const preview = await host.previewBundle(bytes); if (!preview.ok) throw new Error(preview.errors[0]?.message ?? 'Native bundle preview refused.');
    return c.commit(() => {
      if (useViewerStore.getState().pendingAuthoredBundle) throw new Error('A native bundle review is already pending.');
      useViewerStore.getState().setPendingAuthoredBundle(bytes); useViewerStore.getState().setExtensionsRequestedView('installed');
      useViewerStore.getState().openWorkspacePanel('extensions');
      return { state: 'waiting-for-capability-review', extension_id: preview.value.id, version: preview.value.version };
    });
  }),
  coordination('extensions.disable', 'Disable an already installed extension through its native teardown and persisted lifecycle. Does not revoke or roll back previously committed extension work.', ['configuration'], idSchema, async (i, c) => {
    const host = coordinationExtensions(); if (!(await host.listInstalled()).some(record => record.id === i.id)) throw new Error('Unknown installed extension.');
    return c.commitAsync(async () => { await host.setEnabled(i.id, false); const record = (await host.listInstalled()).find(record => record.id === i.id); if (record?.enabled) throw new Error('Native extension disable did not settle.'); return { extension_id: i.id, enabled: false }; });
  }),
  coordination('extensions.uninstall', 'Uninstall one exact installed extension through native runtime teardown, bundle removal and storage lifecycle.', ['configuration'], idSchema, async (i, c) => {
    const host = coordinationExtensions(); if (!(await host.listInstalled()).some(record => record.id === i.id)) throw new Error('Unknown installed extension.');
    return c.commitAsync(async () => { await host.uninstall(i.id); if ((await host.listInstalled()).some(record => record.id === i.id)) throw new Error('Native extension removal did not settle.'); return { removed: i.id }; });
  }),
];
