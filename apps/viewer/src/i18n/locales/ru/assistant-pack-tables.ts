/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const assistantPackTablesRu = {
  "assistantSources.lists.description": "Последний запуск списка: его столбцы, единицы измерения, итоги и строки.",
  "assistantSources.lists.rows": "Строки представляют собой элементы, соответствующие выполненному списку, с указанием значений столбцов.",
  "assistantSources.lists.unavailable": "На момент фиксации данных результата выполнения списка не было. Выполните список на панели Списки и обновите подтверждающие данные.",
  "assistantSources.lists.suggestSummary": "Обобщите этот список и его итоги",
  "assistantSources.lists.suggestGaps": "В каких строках отсутствуют значения?",
  "assistantSources.lists.running": "Выполняется…",
  "assistantSources.lists.ready": {
    one: "{count} строка",
    many: "{count} строк",
    other: "{count} строки",
  },
  "assistantSources.lists.notRun": "Список пока не запущен",
  "assistantSources.charts.title": "Диаграммы",
  "assistantSources.charts.description": "Активная панель управления: категории, значения и то, что не удалось разместить на каждой диаграмме.",
  "assistantSources.charts.rows": "Строки содержат категории диаграмм, для каждой указаны диаграмма, значение, количество и единица измерения.",
  "assistantSources.charts.unavailable": "На момент захвата данных панель диаграмм отсутствовала. Откройте панель Диаграммы и обновите данные.",
  "assistantSources.charts.suggestSummary": "Что бросается в глаза на этих диаграммах?",
  "assistantSources.charts.suggestGaps": "Какие элементы не удалось отобразить на диаграмме и почему?",
  "assistantSources.charts.ready": {
    one: "{count} диаграмма",
    many: "{count} диаграмм",
    other: "{count} диаграммы",
  },
  "assistantSources.charts.noDashboard": "Панель управления пока отсутствует",
  "assistantSources.charts.noCharts": "На панели управления нет диаграмм",
  "assistantSources.cost.description": "Статьи затрат каждой загруженной модели с рассчитанными суммами, валютами и диагностикой.",
  "assistantSources.cost.rows": "Строки представляют записи IfcCostItem с рассчитанной суммой, валютой и диагностикой.",
  "assistantSources.cost.unavailable": "Источник данных о затратах на момент захвата отсутствовал. Загрузите модель IFC, чтобы прочитать данные о её затратах.",
  "assistantSources.cost.suggestSummary": "Подведите итоги затрат по валютам",
  "assistantSources.cost.suggestGaps": "У каких статей затрат не указана сумма и почему?",
  "assistantSources.cost.ready": {
    one: "{count} модель с источником стоимости",
    many: "{count} моделей с источником стоимости",
    other: "{count} модели с источником стоимости",
  },
  "assistantSources.cost.noSource": "Нет источника IFC для чтения стоимости",
} satisfies Catalogue;
