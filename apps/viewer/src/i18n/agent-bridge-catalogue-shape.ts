/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
const AGENT_BRIDGE_TAILS = new Set(('row.title row.description row.connect dialog.title dialog.fromLink dialog.reads '
  + 'dialog.readOnly dialog.localOnly dialog.browserPrompt dialog.start dialog.code dialog.codeHint dialog.port '
  + 'dialog.codeRequired dialog.portInvalid dialog.connect dialog.tryAgain dialog.cancel dialog.connecting '
  + 'dialog.confirmInTab dialog.refreshTabs dialog.useModelTab surfaces.unsent '
  + 'chip.connected chip.connecting chip.ended chip.title panel.since panel.disconnect panel.pairAgain panel.dismiss '
  + 'panel.activity panel.activityNote panel.noActivity panel.noModel panel.ok panel.error panel.cancelled panel.duration '
  + 'failure.unreachable failure.origin failure.permissionDenied failure.pairingFailed failure.protocolMismatch '
  + 'failure.handshakeTimeout failure.invalidMessage failure.busy failure.invalidLink ended.replaced '
  + 'ended.bridgeShutdown ended.connectionLost ended.pageHidden dialog.unverified dialog.target dialog.replaces '
  + 'failure.framed ended.flooded row.showActivity row.hideActivity failure.permissionPrompt dialog.permissionWait '
  + 'chip.connectedCommands panel.sinceCommands panel.allowCommands panel.allowCommandsHint '
  + 'chip.connectedEdits panel.sinceEdits panel.allowEdits panel.allowEditsHint panel.editsCeiling panel.edit panel.editChange '
  + 'panel.editDeleted panel.editUnchanged panel.repeated surfaces.title surfaces.dismiss surfaces.clear surfaces.untitled surfaces.sent').split(' '));
const AGENT_BRIDGE_PARAMETERS: Record<string, readonly string[]> = {
  'dialog.useModelTab': ['name'],
  'dialog.start': ['args'], 'dialog.reads': ['port'], 'dialog.target': ['port'], 'dialog.replaces': ['port'], 'panel.since': ['port', 'time'], 'panel.error': ['code'], 'panel.duration': ['ms'],
  'failure.unreachable': ['port'], 'failure.origin': ['origin'], 'panel.sinceEdits': ['port', 'time'], 'panel.editChange': ['after', 'before', 'entity', 'field'],
  'panel.sinceCommands': ['port', 'time'],
  'panel.editDeleted': ['before', 'entity', 'field'], 'panel.editUnchanged': ['after', 'entity', 'field'], 'panel.repeated': ['count'], 'surfaces.dismiss': ['title'],
};

export function agentBridgeMessageParameters(tail: string): readonly string[] | null {
  return AGENT_BRIDGE_TAILS.has(tail) ? AGENT_BRIDGE_PARAMETERS[tail] ?? [] : null;
}
