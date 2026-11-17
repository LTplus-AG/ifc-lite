/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const assistantUsageDe = {
  "assistantUsage.receiptTokens": "{input} → {output} Tokens · {seconds} s",
  "assistantUsage.receiptUnreported": "Verwendung nicht gemeldet · {seconds} s",
  "assistantUsage.freeRemaining": "Verbleibende kostenlose Anfragen: {remaining} von {limit}",
  "assistantUsage.freeChecking": "Verbleibende kostenlose Anfragen: werden geprüft…",
  "assistantUsage.freeUnknown": "Verbleibende kostenlose Anfragen: unbekannt",
  "assistantUsage.budgetExhausted": "Das Anfragebudget dieser Unterhaltung ist aufgebraucht. Aktualisieren Sie die Belege, um eine neue Unterhaltung zu beginnen.",
} satisfies Catalogue;
