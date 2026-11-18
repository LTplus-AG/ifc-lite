/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The message for each failed or ended local-agent connection (#9523); keys of the lazy `agent-bridge` catalogue. */

import type { TranslationKey } from '@/i18n';
import type { AgentBridgeDisconnectReason, AgentBridgeErrorCode } from './state';

export const ERROR_KEYS: Record<AgentBridgeErrorCode, TranslationKey> = {
  unreachable: 'agentBridge.failure.unreachable',
  'permission-denied': 'agentBridge.failure.permissionDenied',
  'pairing-failed': 'agentBridge.failure.pairingFailed',
  'protocol-mismatch': 'agentBridge.failure.protocolMismatch',
  'handshake-timeout': 'agentBridge.failure.handshakeTimeout',
  'invalid-message': 'agentBridge.failure.invalidMessage',
  busy: 'agentBridge.failure.busy',
  'invalid-link': 'agentBridge.failure.invalidLink',
  framed: 'agentBridge.failure.framed',
};

export const ENDED_KEYS: Record<AgentBridgeDisconnectReason, TranslationKey> = {
  replaced: 'agentBridge.ended.replaced',
  'bridge-shutdown': 'agentBridge.ended.bridgeShutdown',
  'connection-lost': 'agentBridge.ended.connectionLost',
  'page-hidden': 'agentBridge.ended.pageHidden',
  flooded: 'agentBridge.ended.flooded',
};
