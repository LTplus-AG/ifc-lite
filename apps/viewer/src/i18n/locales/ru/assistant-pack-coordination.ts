/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const assistantPackCoordinationRu = {
  "assistantSources.changes.description": "Изменения в истории отмены этой сессии, для каждой операции и модели.",
  "assistantSources.changes.rows": "Строки отображают отдельные изменения активных операций, начиная с самых новых.",
  "assistantSources.changes.unavailable": "Модель не загружена, поэтому нет истории изменений, которую можно было бы прикрепить.",
  "assistantSources.changes.ready": {
    one: "{count} правка",
    many: "{count} правок",
    other: "{count} правки",
  },
  "assistantSources.changes.none": "Пока нет правок",
  "assistantSources.changes.suggestSummary": "Кратко опишите, что было отредактировано и в каких моделях",
  "assistantSources.changes.suggestReview": "Какие изменения следует проверить перед экспортом?",
  "assistantSources.changeSets.description": "Именованные группы правок: их размеры, модели и типы правок.",
  "assistantSources.changeSets.rows": "Строки представляют собой наборы изменений (только метаданные, без значений редактирования или содержимого файлов).",
  "assistantSources.changeSets.unavailable": "Набора изменений не существует. Создайте его на панели Наборы изменений.",
  "assistantSources.changeSets.ready": {
    one: "{count} набор изменений",
    many: "{count} наборов изменений",
    other: "{count} набора изменений",
  },
  "assistantSources.changeSets.none": "Нет наборов изменений",
  "assistantSources.changeSets.suggestSummary": "Кратко опишите, что содержит каждый набор изменений",
  "assistantSources.schedule.description": "Задачи календарного плана 4D с датами, контрольными этапами и назначенными объектами.",
  "assistantSources.schedule.rows": "Строки содержат задачи календарного плана. Отсутствующие даты имеют значение null, а не подбираются предположительно.",
  "assistantSources.schedule.unavailable": "Календарный план не загружен. Откройте панель Календарный план для чтения данных IfcTask либо создайте или импортируйте календарный план.",
  "assistantSources.schedule.ready": {
    one: "{count} задача",
    many: "{count} задач",
    other: "{count} задачи",
  },
  "assistantSources.schedule.none": "Нет календарного плана",
  "assistantSources.schedule.suggestSummary": "Обобщите календарный план: этапы, вехи и общую продолжительность",
  "assistantSources.schedule.suggestGaps": "У каких задач не заданы даты или не назначены объекты?",
  "assistantSources.semantic.description": "Связанные записи, их сопоставление с элементами модели, результаты проверки и прикреплённые тексты спецификаций.",
  "assistantSources.semantic.rows": "Строки содержат сначала прикреплённые фрагменты текста с точными смещениями, затем связанные записи с результатами их сопоставления, затем результаты проверки.",
  "assistantSources.semantic.unavailable": "Связанные записи не загружены, и тексты не прикреплены. Загрузите записи или прикрепите текст на панели Связанные записи.",
  "assistantSources.semantic.ready": {
    one: "{count} запись · результаты {findings}",
    many: "{count} записей · результаты {findings}",
    other: "{count} записи · результаты {findings}",
  },
  "assistantSources.semantic.none": "Записи не загружены",
  "assistantSources.semantic.suggestUnresolved": "Какие записи не соответствуют элементам модели и почему?",
  "assistantSources.semantic.suggestFindings": "Объясните результаты проверки",
  "assistantSources.review.description": "Одна координационная карточка из рабочей области проверки: результаты нескольких анализов одних и тех же проверенных элементов.",
  "assistantSources.review.rows": "Строки представляют замечания в карточке с указанием для каждого исходного анализа, статуса встроенной проверки и того, является ли запуск текущим, историческим или частичным.",
  "assistantSources.review.unavailable": "Карточка не закреплена. Выберите Задать вопрос об этой карточке на карточке в рабочей области Проверка.",
  "assistantSources.review.ready": {
    one: "{count} результат в закреплённой карточке",
    many: "{count} результатов в закреплённой карточке",
    other: "{count} результата в закреплённой карточке",
  },
  "assistantSources.review.none": "Нет закреплённой карточки",
  "assistantSources.review.suggestExplain": "Почему эти результаты указывают на одни и те же элементы?",
  "assistantSources.review.suggestNext": "Что координатор проверил бы дальше в этой карточке?",
} satisfies Catalogue;
