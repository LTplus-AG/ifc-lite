/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * The "use your own API key" (BYOK) surfaces: `ByokCredentialForm.tsx`,
 * `ByokKeyModal.tsx`, `ByokStreamingPill.tsx`, and `ByokTrustDiagram.tsx`
 * (#4918 chat slice), split from the sibling `chat.en.ts` catalogue purely
 * because it is its own sub-feature — both share no keys.
 */
export const chatByokEn = {
  // ── ByokCredentialForm.tsx ──
  'chatByok.credentialForm.replaceKeyLabel': 'Replace existing key',
  'chatByok.credentialForm.pasteKeyLabel': 'Paste your key',
  'chatByok.credentialForm.hideKeyAria': 'Hide key',
  'chatByok.credentialForm.showKeyAria': 'Show key',
  'chatByok.credentialForm.looksLikeKey': 'Looks like a {label} key ({masked}).',
  'chatByok.credentialForm.doesntLookLikeKey': "That doesn't look like a {label} key (expected prefix {prefix}).",
  'chatByok.credentialForm.workspaceLabel': 'Workspace ID',
  'chatByok.credentialForm.workspaceOptionalSuffix': '— optional',
  'chatByok.credentialForm.workspacePlaceholder': 'wrkspc_...',
  'chatByok.credentialForm.workspaceHelp': 'Only needed if your key reaches more than one workspace — Anthropic then rejects every request until one is named. A key created for a single workspace needs nothing here.',
  'chatByok.credentialForm.workspaceInvalidHelp': "That contains a character that doesn't belong in a workspace ID — usually an invisible one picked up while copying. Retype it, or paste it again.",
  'chatByok.credentialForm.saveButton': 'Save',
  'chatByok.credentialForm.configuredLabel': 'Configured:',
  'chatByok.credentialForm.removeButton': 'Remove',

  // ── ByokKeyModal.tsx ──
  'chatByok.keyModal.title': 'Use your own API key',
  'chatByok.keyModal.description': 'Unlocks frontier models. Your key stays in this browser and goes straight to the provider — never through our servers.',
  'chatByok.provider.anthropic': 'Anthropic',
  'chatByok.provider.openai': 'OpenAI',
  'chatByok.keyModal.unlocksLabel': 'Unlocks:',
  'chatByok.keyModal.trustBullet1Prefix': "Key stored only in this browser's",
  'chatByok.keyModal.trustBulletLocalStorage': 'localStorage',
  'chatByok.keyModal.trustBullet1Suffix': 'Inspect any time in DevTools.',
  'chatByok.keyModal.trustBullet2Prefix': 'Every request goes to',
  'chatByok.keyModal.trustBullet2Suffix': '. Verify in DevTools → Network → filter',
  'chatByok.keyModal.trustBullet3Prefix': 'The whole BYOK code path is short enough to read.',
  'chatByok.keyModal.fileListSeparator': ' and ',
  'chatByok.keyModal.walkthroughToggle': "Don't have a key? 60-second walkthrough",
  'chatByok.keyModal.walkthroughStep1': 'Open the {provider} console — opens in a new tab.',
  'chatByok.keyModal.walkthroughStep2Prefix': 'Click',
  'chatByok.keyModal.walkthroughStep2CreateKey': 'Create Key',
  'chatByok.keyModal.walkthroughStep2Middle': ', name it',
  'chatByok.keyModal.walkthroughStep2CodeName': 'ifc-lite',
  'chatByok.keyModal.walkthroughStep2AnthropicNote': ' Scope it to a single workspace — a key that spans several needs a Workspace ID here as well.',
  'chatByok.keyModal.walkthroughStep3': "Set a spending limit (e.g. $10/month) so a leaked key can't burn you. The provider enforces it.",
  'chatByok.keyModal.walkthroughStep4': 'Copy the key, come back here, paste it into the input above (the field is already focused — just press',
  'chatByok.keyModal.openConsoleButton': 'Open {consoleLabel}',

  // ── ByokStreamingPill.tsx ──
  'chatByok.streamingPill.tooltip': 'Messages from this model go directly from your browser to {host}. To verify, open DevTools → Network and filter {shortHost}.',

  // ── ByokTrustDiagram.tsx ──
  'chatByok.trustDiagram.ariaLabel': 'Diagram: requests go directly from your browser to {apiHost}, not via our server.',
  'chatByok.trustDiagram.activeFlowLabel': '✓ How your requests actually flow',
  'chatByok.trustDiagram.browserBox': 'Your browser',
  'chatByok.trustDiagram.httpsDirect': 'HTTPS · direct',
  'chatByok.trustDiagram.blockedFlowLabel': '✗ What we never do',
  'chatByok.trustDiagram.ourServerBox': 'our server',
} as const satisfies Record<string, TranslationValue>;
