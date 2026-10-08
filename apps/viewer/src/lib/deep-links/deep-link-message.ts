/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationKey } from '@/i18n';
import type { DeepLinkOutcome } from './resolve-artifact-link';

/** What to tell the user about a deep link that did not fully resolve. */
export function deepLinkMessage(outcome: DeepLinkOutcome): { key: TranslationKey; params?: Record<string, string> } | null {
  switch (outcome.status) {
    case 'opened': return null;
    case 'busy': return { key: 'workspaceMigration.deepLink.busy' };
    case 'unavailable': return { key: 'workspaceMigration.deepLink.unavailable' };
    case 'missing':
      switch (outcome.kind) {
        case 'conversation': return { key: 'workspaceMigration.deepLink.missingConversation' };
        case 'receipt': return { key: 'workspaceMigration.deepLink.missingReceipt' };
        case 'bcfDraft': return { key: 'workspaceMigration.deepLink.missingBcfDraft' };
      }
      return null;
    case 'refused':
      switch (outcome.reason) {
        case 'unknown-panel': return { key: 'workspaceMigration.deepLink.unknownPanel' };
        case 'conflicting-target': return { key: 'workspaceMigration.deepLink.conflicting' };
        case 'invalid-id': return { key: 'workspaceMigration.deepLink.invalidId' };
      }
  }
}
