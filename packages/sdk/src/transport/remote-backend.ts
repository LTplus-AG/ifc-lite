/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * RemoteBackend — implements BimBackend by proxying all calls over a Transport.
 *
 * Used when the SDK is in a different context than the viewer (cross-tab, iframe, etc).
 * Each typed namespace is a Proxy that throws synchronously, since the remote transport
 * requires async implementation (future iteration).
 */

import type {
  BimBackend,
  Transport,
  BimEventType,
  ModelBackendMethods,
  QueryBackendMethods,
  SelectionBackendMethods,
  VisibilityBackendMethods,
  ViewerBackendMethods,
  MutateBackendMethods,
  SpatialBackendMethods,
  ExportBackendMethods,
  LensBackendMethods,
  FilesBackendMethods,
  ScheduleBackendMethods,
} from '../types.js';

function makeRemoteProxy<T extends object>(namespace: string): T {
  return new Proxy(Object.create(null) as T, {
    get(_, method: string) {
      return (..._args: unknown[]): never => {
        throw new Error(
          `RemoteBackend: Cannot call ${namespace}.${method}() synchronously. ` +
          `Remote transport requires async implementation.`
        );
      };
    },
  });
}

export class RemoteBackend implements BimBackend {
  readonly model: ModelBackendMethods = makeRemoteProxy('model');
  readonly query: QueryBackendMethods = makeRemoteProxy('query');
  readonly selection: SelectionBackendMethods = makeRemoteProxy('selection');
  readonly visibility: VisibilityBackendMethods = makeRemoteProxy('visibility');
  readonly viewer: ViewerBackendMethods = makeRemoteProxy('viewer');
  readonly mutate: MutateBackendMethods = makeRemoteProxy('mutate');
  readonly spatial: SpatialBackendMethods = makeRemoteProxy('spatial');
  readonly export: ExportBackendMethods = makeRemoteProxy('export');
  readonly lens: LensBackendMethods = makeRemoteProxy('lens');
  readonly files: FilesBackendMethods = makeRemoteProxy('files');
  readonly schedule: ScheduleBackendMethods = makeRemoteProxy('schedule');

  constructor(private transport: Transport) {}

  subscribe(event: BimEventType, handler: (data: unknown) => void): () => void {
    return this.transport.subscribe((sdkEvent) => {
      if (sdkEvent.type === event) {
        handler(sdkEvent.data);
      }
    });
  }
}
