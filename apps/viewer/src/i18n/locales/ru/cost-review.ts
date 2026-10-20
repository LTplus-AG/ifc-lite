/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const costReviewRu = {
  "costReview.title": "Проверить предоставленные данные о затратах",
  "costReview.hint": "Проверяйте только предоставленные суммы и исходные единицы измерения. Цена, ставка или валюта не выводятся автоматически. Выберите операции, затем проверьте все изменения IFC перед применением.",
  "costReview.prepare": "Проверить выбранные операции с затратами",
  "costReview.references": "Исходный целевой объект: {target} · связанные записи: {related}",
  "costReview.detach": "Отсоедините общие ссылки, используя встроенные правила удаления. Проверьте все изменённые и удалённые записи ниже.",
  "costReview.population": "Проверено исходных записей {records} · создано {created} · изменено {modified} · удалено {deleted}. Идентификаторы создаваемых объектов IFC назначаются при применении.",
  "costReview.nativeChanges": "Проверить изменения в исходном IFC, включая общие ссылки и удаления",
  "costReview.receiptProblem": "Изменения были применены, но их подтверждение не удалось сохранить. В истории изменений по-прежнему содержатся внесённые изменения.",
  "costReview.op.cost.schedule.create": "Создать ведомость затрат",
  "costReview.op.cost.item.create": "Создать статью затрат",
  "costReview.op.cost.value.create": "Создать указанное значение стоимости",
  "costReview.op.cost.quantity.create": "Создать указанную количественную характеристику",
  "costReview.op.cost.items.nest": "Вложить статьи затрат",
  "costReview.op.cost.schedule.assign": "Назначить статьи ведомости затрат",
  "costReview.op.cost.item.assign": "Назначить объекты статье затрат",
  "costReview.op.cost.item.values": "Заменить значения стоимости статьи затрат",
  "costReview.op.cost.remove": "Удалить запись о затратах",
} satisfies Catalogue;
