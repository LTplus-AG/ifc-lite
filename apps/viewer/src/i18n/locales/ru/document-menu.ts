/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const documentMenuRu = {
  "documentMenu.namePrompt": "Название документа",
  "documentMenu.copySuffix": "{name} (копия)",
  "documentMenu.imported": "Импортирован документ \"{name}\"",
  "documentMenu.importFailed": "Не удалось импортировать документ",
  "documentMenu.importFailedWithReason": "Не удалось импортировать документ: {reason}",
  "documentMenu.actions": "Действия с документами",
  "documentMenu.actionsTitle": "Изменить название, скопировать, удалить, экспортировать или импортировать документ",
  "documentMenu.rename": "Переименовать",
  "documentMenu.duplicate": "Дублировать",
  "documentMenu.delete": "Удалить",
  "documentMenu.exportTemplate": "Экспортировать шаблон…",
  "documentMenu.importTemplate": "Импортировать шаблон…",
} satisfies Catalogue;
