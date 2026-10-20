/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const assistantUsageRu = {
  "assistantUsage.receiptTokens": "токенов {input} → {output} · {seconds} с",
  "assistantUsage.receiptUnreported": "Использование не указано · {seconds} с",
  "assistantUsage.freeRemaining": "Осталось бесплатных запросов: {remaining} из {limit}",
  "assistantUsage.freeChecking": "Осталось бесплатных запросов: проверка…",
  "assistantUsage.freeUnknown": "Осталось бесплатных запросов: неизвестно",
  "assistantUsage.budgetExhausted": "В этом обсуждении исчерпан бюджет запросов. Обновите подтверждающие данные, чтобы начать новое обсуждение.",
} satisfies Catalogue;
