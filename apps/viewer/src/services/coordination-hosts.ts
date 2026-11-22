/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ExtensionHostService } from './extensions/host';
import type { SourceHost } from './sources/source-host';
let extensions: ExtensionHostService | null = null;
let sources: SourceHost | null = null;
export function attachCoordinationExtensions(host: ExtensionHostService): () => void {
  extensions = host; return () => { if (extensions === host) extensions = null; };
}
export function attachCoordinationSources(host: SourceHost): () => void {
  sources = host; return () => { if (sources === host) sources = null; };
}
export function coordinationExtensions(): ExtensionHostService {
  if (!extensions) throw new Error('The viewer extension host is not mounted.'); return extensions;
}
export function coordinationSources(): SourceHost {
  if (!sources) throw new Error('The viewer source host is not mounted.'); return sources;
}
