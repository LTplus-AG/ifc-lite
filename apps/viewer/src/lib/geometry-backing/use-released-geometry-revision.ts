/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A revision for anything a mounted consumer computed from released-geometry
 * metadata (#10264): it moves whenever the provider's answers may have changed
 * in place. That is a metadata notification (provider start/stop, CPU release,
 * an acknowledged or failed generation) OR a geometry content-version change,
 * which supersedes the sealed backing without touching any model or mesh list
 * identity. Use it as a memo dependency next to the geometry inputs.
 */

import { useSyncExternalStore } from 'react';
import { useViewerStore } from '@/store';
import { releasedGeometryMetadataVersion, subscribeReleasedGeometryMetadata } from './released-geometry-metadata';

export function useReleasedGeometryRevision(): string {
  const metadata = useSyncExternalStore(subscribeReleasedGeometryMetadata, releasedGeometryMetadataVersion, releasedGeometryMetadataVersion);
  const content = useViewerStore((state) => state.geometryContentVersion);
  return `${metadata}:${content}`;
}
