/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const workspaceMigrationRu = {
  "workspaceMigration.layout.title": "Проверьте обновлённый макет",
  "workspaceMigration.layout.summary": "Изменений расположения для проверки {count}. Сохранённая работа не затронута.",
  "workspaceMigration.layout.showChanges": "Показать изменения",
  "workspaceMigration.layout.hideChanges": "Скрыть изменения",
  "workspaceMigration.layout.keep": "Сохранить расположение",
  "workspaceMigration.layout.reset": "Сбросить расположение",
  "workspaceMigration.layout.added": "Добавлено {panel} после {anchor}.",
  "workspaceMigration.layout.addedTop": "Добавлен {panel} в список панелей.",
  "workspaceMigration.layout.renamed": "Переименовано {from} в {panel}.",
  "workspaceMigration.layout.restored": "Восстановлен {panel} в списке панелей.",
  "workspaceMigration.layout.preserved": "Недоступное место размещения {id} было сохранено на потом.",
  "workspaceMigration.layout.regrouped": "Группы панелей обновлены.",
  "workspaceMigration.layout.mode": "Обновлён режим боковой панели.",
  "workspaceMigration.layout.unreadable": "Сохранённый макет не удалось прочитать. Оригинал сохранён для восстановления.",
  "workspaceMigration.placement.title": "Недоступные варианты размещения дополнительных модулей",
  "workspaceMigration.placement.notRendered": "В просмотрщике нет поверхности для {slot}. Размещение сохранено.",
  "workspaceMigration.placement.hostOwned": "{slot} принадлежит просмотрщику; расширения не могут заменить эту поверхность.",
  "workspaceMigration.placement.unknownSlot": "Слот {slot} неизвестен. Расположение сохранено.",
  "workspaceMigration.deepLink.copy": "Скопировать ссылку",
  "workspaceMigration.deepLink.copyNamed": "Скопировать ссылку на {name}",
  "workspaceMigration.deepLink.copied": "Ссылка скопирована",
  "workspaceMigration.deepLink.copyFailed": "Ссылка не скопирована.",
  "workspaceMigration.deepLink.failed": "Не удалось открыть связанный элемент.",
  "workspaceMigration.deepLink.busy": "Дождитесь завершения текущего запроса, затем снова откройте ссылку.",
  "workspaceMigration.deepLink.unavailable": "Связанный элемент недоступен в этом браузере.",
  "workspaceMigration.deepLink.missingConversation": "Сохранённая переписка не найдена в этом браузере.",
  "workspaceMigration.deepLink.missingReceipt": "В данной сессии подтверждение запроса не найдено.",
  "workspaceMigration.deepLink.missingBcfDraft": "Данный черновик BCF не был найден в этом браузере.",
  "workspaceMigration.deepLink.unknownPanel": "В ссылке указана неизвестная панель.",
  "workspaceMigration.deepLink.conflicting": "Ссылка содержит противоречащие друг другу назначения.",
  "workspaceMigration.deepLink.invalidId": "Ссылка содержит недопустимый идентификатор элемента.",
} satisfies Catalogue;
