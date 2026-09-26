/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * The chat panel's own chrome: `ChatPanel.tsx`, `ChatMessage.tsx`,
 * `ExecutableCodeBlock.tsx`, and `ModelSelector.tsx` (#4918 chat slice).
 * The BYOK key-entry surfaces (`ByokCredentialForm.tsx`, `ByokKeyModal.tsx`,
 * `ByokStreamingPill.tsx`, `ByokTrustDiagram.tsx`) are a sibling catalogue,
 * `chat-byok.en.ts`, under the `chatByok.*` namespace.
 */
export const chatEn = {
  // ── ChatMessage.tsx ──
  'chat.message.attachmentRows': {
    one: '({count} row)',
    other: '({count} rows)',
  },

  // ── ExecutableCodeBlock.tsx ──
  'chat.codeBlock.languageFallback': 'js',
  'chat.codeBlock.copyCode': 'Copy code',
  'chat.codeBlock.applyToSelection': 'Apply to selection',
  'chat.codeBlock.replaceAll': 'All',
  'chat.codeBlock.replaceEntireScript': 'Replace entire script',
  'chat.codeBlock.running': 'Running...',
  'chat.codeBlock.run': 'Run',
  'chat.codeBlock.executeInSandbox': 'Execute in sandbox',
  'chat.codeBlock.console': 'Console',
  'chat.codeBlock.durationBadge': '{ms}ms',
  'chat.codeBlock.executingScript': 'Executing script...',
  'chat.codeBlock.done': 'Done',
  'chat.codeBlock.doneWithDuration': 'Done in {ms}ms',
  'chat.codeBlock.fixThis': 'Fix this',
  'chat.codeBlock.rerun': 'Re-run',

  // ── ModelSelector.tsx ──
  'chat.modelSelector.free': 'Free',
  'chat.modelSelector.anthropic': 'Anthropic',
  'chat.modelSelector.openai': 'OpenAI',

  // ── ChatPanel.tsx ──
  'chat.panel.dropOverlay': 'Drop files or images',
  'chat.panel.clearTooltip': 'Clear',
  'chat.panel.authoringBadgeTooltip': 'Authoring contract attached ({intent})',
  'chat.panel.authoringBadgeFork': 'Fork',
  'chat.panel.authoringBadgeAuthoring': 'Authoring',
  'chat.panel.authoringBadge': '{label} · {seconds}s',
  'chat.panel.manageKeysLabel': 'Manage API keys',
  'chat.panel.addKeyLabel': 'Add API key for frontier models',
  'chat.panel.autoRunStatus': 'Auto-run: {state}',
  'chat.panel.stateOn': 'ON',
  'chat.panel.stateOff': 'OFF',
  'chat.panel.providerAnthropic': 'Anthropic',
  'chat.panel.providerOpenai': 'OpenAI',
  'chat.panel.keyNeededStrong': '{provider} key needed',
  'chat.panel.keyNeededSuffix': 'for this model — click to set it up',
  'chat.panel.clearConfirmPrompt': 'Clear {count} messages?',
  'chat.panel.clearConfirmButton': 'Clear',
  'chat.panel.clearCancelButton': 'Cancel',
  'chat.panel.emptyStateHint': 'Try something:',
  'chat.panel.sendingIndicator': 'Thinking...',
  'chat.panel.bundleReadyTitle': '"{name}" is ready',
  'chat.panel.defaultExtensionName': 'Your extension',
  'chat.panel.scriptReadyTitle': 'Your tool is ready',
  'chat.panel.installCtaPrefix': 'Last step — turn this into a permanent',
  'chat.panel.installCtaHighlight': 'one-click button in your toolbar',
  'chat.panel.reviewInstallButton': 'Review & install',
  'chat.panel.installAsToolButton': 'Install as tool',
  'chat.panel.notNowButton': 'Not now',
  'chat.panel.continueButton': 'Continue',
  'chat.panel.contactSupportLink': 'Contact support',
  'chat.panel.attachTooltipEnabled': 'Attach file or image (paste, drag & drop)',
  'chat.panel.attachTooltipDisabled': 'Selected model does not support attachments',
  'chat.panel.placeholderNeedsKey': 'Add your {provider} key to chat with this model',
  'chat.panel.placeholderDefault': 'Ask anything...',
  'chat.panel.stopGeneratingTooltip': 'Stop generating',
  'chat.panel.sendTooltip': 'Send (Enter)',
  'chat.panel.streamingIndicator': 'Streaming...',
  'chat.panel.usageCredits': '{used}/{limit} credits · resets {resetLabel}',
  'chat.panel.usageRequests': '{used}/{limit} requests · resets {resetLabel}',
  'chat.panel.shiftEnterHint': 'Shift+Enter new line',
  'chat.panel.closeLabel': 'Close AI chat',
  'chat.panel.scrollToBottomLabel': 'Scroll to the latest message',
} as const satisfies Record<string, TranslationValue>;
