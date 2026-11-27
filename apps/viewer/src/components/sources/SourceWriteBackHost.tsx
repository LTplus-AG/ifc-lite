/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { Suspense, useEffect, useState } from 'react';
import { lazyChunk } from '@/lib/lazy-chunk';
import { onOpenSourceWriteBack } from '@/services/sources/source-writeback-command';

const SourceWriteBackDialog = lazyChunk(() => import('./SourceWriteBackDialog').then(module => ({ default: module.SourceWriteBackDialog })));

/** Mounts one Save to source dialog at a time, opened by `openSourceWriteBack`. Must sit inside `SourceHostProvider`. */
export function SourceWriteBackHost() {
  const [modelId, setModelId] = useState<string | null>(null);
  useEffect(() => onOpenSourceWriteBack(id => setModelId(previous => previous ?? id)), []);
  return modelId && <Suspense fallback={null}><SourceWriteBackDialog key={modelId} modelId={modelId} onClose={() => setModelId(null)} /></Suspense>;
}
