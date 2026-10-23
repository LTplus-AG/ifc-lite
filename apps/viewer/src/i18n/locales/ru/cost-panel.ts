/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const costPanelRu = {
  "costPanel.title": "Стоимость",
  "costPanel.close": "Закрыть",
  "costPanel.exportCsv": "Экспортировать CSV",
  "costPanel.noModelsLoaded": "Модели не загружены.",
  "costPanel.dataUnavailable": "Данные о затратах недоступны — загрузите исходный файл IFC для проверки затрат.",
  "costPanel.dataUnavailableWithError": "Данные о стоимости недоступны: {message}",
  "costPanel.empty": "В данной модели отсутствуют данные о стоимости.",
  "costPanel.noItemsInModel": "В этой модели нет статей затрат.",
  "costPanel.noItemsInSchedule": "Статьи затрат не назначены.",
  "costPanel.unassignedItems": "Нераспределённые статьи затрат",
  "costPanel.cyclicBadge": "Обнаружен цикл вложенности",
  "costPanel.mixedCurrencyBadge": "Разные валюты",
  "costPanel.selectPrompt": "Выберите статью затрат для проверки.",
  "costPanel.itemUnavailable": "Данная статья затрат больше недоступна.",
  "costPanel.resolvedValue": "Вычисленное значение",
  "costPanel.unresolvedValue": "Не удалось вычислить по загруженному источнику.",
  "costPanel.schedule": "Ведомость затрат",
  "costPanel.quantities": "Количественные характеристики",
  "costPanel.assignedTargets": "Назначенные объекты / задачи",
  "costPanel.selectInViewport": "Выбрать в 3D",
  "costPanel.noAssignedTargets": "Объекты и задачи не назначены.",
  "costPanel.collapse": "Свернуть",
  "costPanel.expand": "Развернуть",
  "costPanel.itemFallbackName": "Статья затрат #{id}",
  "costPanel.scheduleFallbackName": "Ведомость затрат #{id}",
  "costPanel.identification": "ID {value}",
} satisfies Catalogue;
