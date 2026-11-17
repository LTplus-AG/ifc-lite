/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { Renderer } from '@ifc-lite/renderer';
import type { OperationContext } from './contract';
import type { ToolHost } from '../types';
import type { ScanSession } from '@/lib/appearance/scan/session';
import type {
  ScanLandmark,
  ScanPair,
  ScanRegistrationRequest,
  ScanRegistrationReport,
} from '@/lib/appearance/scan/types';
import type { AppearanceAssetOwner } from '@/lib/appearance/assets';
import type { prepareMeshTransfer } from '@/lib/appearance/scan/prepare-transfer';
import type { stageNativeScanTransfer } from '@/lib/appearance/appearance-native-transfer';
import { appearanceAssets } from '@/lib/appearance/model-assets';
export interface NativeScanState {
  session: ScanSession;
  pairs: ScanPair[];
  pending?: { point: ScanLandmark; partition: 'fit' | 'check' };
  result?: { request: ScanRegistrationRequest; report: ScanRegistrationReport };
  recovery?: { request: ScanRegistrationRequest; rebind: (next: ScanSession) => void };
  version: number;
  transfer?: {
    output: Awaited<ReturnType<typeof prepareMeshTransfer>>;
    owner: AppearanceAssetOwner;
    stage: ReturnType<typeof stageNativeScanTransfer>;
    original: boolean;
    renderer: Renderer;
    applying?: boolean;
    releaseRequested?: boolean;
    applied?: unknown;
  };
}
const hosts = new WeakMap<ToolHost, Map<string, NativeScanState>>();
export function nativeScanStates(c: { host: ToolHost }) {
  let map = hosts.get(c.host);
  if (!map) {
    map = new Map();
    hosts.set(c.host, map);
    const values = map;
    c.host.lifetimeSignal?.addEventListener(
      'abort',
      () => {
        for (const state of values.values()) releaseNativeScanTransfer(state);
        values.clear();
      },
      { once: true },
    );
  }
  return map;
}
export function nativeScanState(c: OperationContext, token: string, version?: number, validate = true) {
  const value = nativeScanStates(c).get(token);
  if (!value || value.session.targetModelId !== c.model.id)
    throw new Error('Unknown scan session for this host/target model.');
  if (version !== undefined && value.version !== version)
    throw new Error('Scan correspondences or registration changed. Inspect again.');
  if (validate) {
    if (value.transfer?.applying) throw new Error('The native scan transfer is being applied.');
    value.session.validate();
  }
  return value;
}
export function releaseNativeScanTransfer(state: NativeScanState) {
  const transfer = state.transfer;
  if (!transfer) return;
  if (transfer.applying) {
    transfer.releaseRequested = true;
    return;
  }
  try {
    transfer.stage.preview.cancel();
  } finally {
    appearanceAssets.releaseOwner(transfer.owner);
    state.transfer = undefined;
  }
}
