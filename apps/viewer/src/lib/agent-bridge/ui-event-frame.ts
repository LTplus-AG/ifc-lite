/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { parseTabMessage, type BridgeUiEvent } from '@ifc-lite/mcp/bridge-protocol';

/**
 * Send one click on an agent-pushed surface as a `ui-event` frame, checked
 * with the bridge's own parser first. A context over the bridge's bound (a
 * large selection) is dropped so the prompt still reaches the agent. False
 * when the frame would be refused or the socket throws; the caller then keeps
 * the click in the tab.
 */
export function sendUiEventFrame(send: (json: string) => void, sessionId: string, event: BridgeUiEvent): boolean {
  const frame = (e: BridgeUiEvent) => JSON.stringify({ type: 'ui-event', sessionId, event: e });
  let json = frame(event);
  let valid = parseTabMessage(json);
  if (!valid.ok && event.context !== undefined) {
    const { context: _dropped, ...bare } = event;
    json = frame(bare);
    valid = parseTabMessage(json);
  }
  if (!valid.ok) {
    console.warn(`[agent-bridge] the UI event would be refused by the bridge: ${valid.error}`);
    return false;
  }
  try {
    send(json);
    return true;
  } catch (err) {
    console.warn('[agent-bridge] could not send the UI event to the bridge', err);
    return false;
  }
}
