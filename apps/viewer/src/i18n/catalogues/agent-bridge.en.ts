/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Local agent bridge (#9523): the Sources panel row, the connect dialog, the
 * status-bar chip and its activity log. A lazy catalogue registered by those
 * lazily loaded components; only the command-palette label ships eagerly.
 */
export const agentBridgeEn = {
  'agentBridge.row.title': 'Local agent',
  'agentBridge.row.description': 'Let an AI agent on this computer (Claude Desktop, Claude Code and other MCP clients) read the model open in this tab.',
  'agentBridge.row.connect': 'Connect local agent',

  'agentBridge.dialog.title': 'Connect a local agent',
  'agentBridge.dialog.fromLink': 'You opened a pairing link from the ifc-lite agent bridge.',
  'agentBridge.dialog.reads': 'A program on this computer will be able to read the model(s) open in this tab, including unsaved edits.',
  'agentBridge.dialog.readOnly': 'Read-only: the agent cannot change the model, export it, or open or save files.',
  'agentBridge.dialog.localOnly': 'The connection goes only to this computer (127.0.0.1, port {port}). The model is not sent to ifclite.com or any other server.',
  'agentBridge.dialog.browserPrompt': 'Your browser may ask whether this site may connect to devices on your local network (in Chrome: a "Local network access" prompt). Allow it so the viewer can reach the bridge on this computer.',
  'agentBridge.dialog.start': 'Start the bridge on this computer, or let your agent start it:',
  'agentBridge.dialog.code': 'Pairing code',
  'agentBridge.dialog.codeHint': 'Printed by the bridge when it starts, and returned by its bridge_status tool. A code works once.',
  'agentBridge.dialog.port': 'Port',
  'agentBridge.dialog.codeRequired': 'Enter the pairing code the bridge printed.',
  'agentBridge.dialog.portInvalid': 'Enter a port from 1 to 65535.',
  'agentBridge.dialog.connect': 'Connect',
  'agentBridge.dialog.tryAgain': 'Try again',
  'agentBridge.dialog.cancel': 'Cancel',
  'agentBridge.dialog.connecting': 'Connecting to the bridge on this computer…',

  'agentBridge.chip.connected': 'Local agent connected · read-only',
  'agentBridge.chip.connecting': 'Connecting local agent…',
  'agentBridge.chip.ended': 'Local agent disconnected',
  'agentBridge.chip.title': 'Local agent: connection and activity',
  'agentBridge.panel.since': 'Connected on port {port} since {time}. The agent can read the model(s) in this tab, including unsaved edits; it cannot change them.',
  'agentBridge.panel.disconnect': 'Disconnect',
  'agentBridge.panel.pairAgain': 'Pair again',
  'agentBridge.panel.dismiss': 'Dismiss',
  'agentBridge.panel.activity': 'Activity',
  'agentBridge.panel.activityNote': 'Tool names, models and timings only. Arguments and results are not kept.',
  'agentBridge.panel.noActivity': 'No tool calls yet.',
  'agentBridge.panel.noModel': 'no model',
  'agentBridge.panel.ok': 'ok',
  'agentBridge.panel.error': 'error {code}',
  'agentBridge.panel.cancelled': 'cancelled',
  'agentBridge.panel.duration': '{ms} ms',

  'agentBridge.failure.unreachable': 'Could not connect to the bridge on port {port}, or it dropped the connection. Start the bridge on this computer with the command below, check the port, then pair with the code it prints. If it is running, it may have refused the connection because too many tabs were trying to pair: close them and try again.',
  'agentBridge.failure.origin': 'Viewer not on ifclite.com? Start the bridge with --bridge-viewer-url {origin} so it accepts this page.',
  'agentBridge.failure.permissionDenied': 'The browser blocked the connection to this computer. In Chrome, open this site\'s settings (the icon left of the address), allow "Local network access", then try again.',
  'agentBridge.failure.pairingFailed': 'The bridge did not accept this code. A code works once and a new one is issued after each pairing: ask the agent for a fresh link (bridge_status) or copy the latest code from the bridge.',
  'agentBridge.failure.protocolMismatch': 'This viewer and the bridge speak different protocol versions. Update the bridge (npx @ifc-lite/mcp@latest --bridge), reload this page, then pair again.',
  'agentBridge.failure.handshakeTimeout': 'The bridge did not finish pairing in time. Try again with a fresh code.',
  'agentBridge.failure.invalidMessage': 'The bridge rejected a message from this viewer. Update @ifc-lite/mcp, reload this page, then pair again.',
  'agentBridge.failure.busy': 'The bridge has too many connections waiting to pair. Close other tabs that are trying to connect, then try again.',
  'agentBridge.failure.invalidLink': 'This pairing link could not be read. Ask the agent for a new one (bridge_status), or enter the code below.',
  'agentBridge.ended.replaced': 'Another tab was paired with the bridge and replaced this one. To use this tab again, pair it with a fresh link.',
  'agentBridge.ended.bridgeShutdown': 'The bridge shut down. Start it again and pair with the new code it prints.',
  'agentBridge.ended.connectionLost': 'The connection to the bridge was lost. A pairing code works once, so pair again with a fresh link or code.',
  'agentBridge.ended.pageHidden': 'The connection closed when this page was unloaded. Pair again with a fresh link or code.',
} as const;
