/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const assistantPackChecksRu = {
  "assistantSources.duplicates.title": "Дублирующиеся элементы",
  "assistantSources.duplicates.description": "Наборы совпадающих или перекрывающихся копий, обнаруженных при поиске дубликатов.",
  "assistantSources.duplicates.rows": "Каждая строка представляет один набор совпадающих элементов, а не одну пару.",
  "assistantSources.duplicates.unavailable": "На момент фиксации результат поиска дубликатов был недоступен. Запустите поиск дубликатов в проверке коллизий и обновите подтверждающие данные.",
  "assistantSources.duplicates.suggestSummary": "Кратко опишите наборы дубликатов и типы элементов, которые в них входят",
  "assistantSources.duplicates.suggestCleanup": "Какие наборы дубликатов выглядят как точные копии, которые следует удалить в первую очередь?",
  "assistantSources.duplicates.pickSets": {
    one: "{count} набор дубликатов",
    many: "{count} наборов дубликатов",
    other: "{count} набора дубликатов",
  },
  "assistantSources.manualChecklist.title": "Чек-лист ручной проверки",
  "assistantSources.manualChecklist.description": "Открытый чек-лист ручной проверки и вердикты, записанные проверяющими для каждой загруженной модели.",
  "assistantSources.manualChecklist.rows": "Каждая строка представляет один пункт чек-листа для одной модели с вердиктом проверяющего или пока без него.",
  "assistantSources.manualChecklist.unavailable": "На момент фиксации данных чек-лист ручной проверки не был открыт. Откройте или создайте его в разделе Проверка данных и обновите подтверждающие данные.",
  "assistantSources.manualChecklist.suggestSummary": "Подведите итоги выполнения чек-листа и перечислите непройденные пункты",
  "assistantSources.manualChecklist.suggestOpen": "Какие пункты остались без ответа и что следует проверить дальше?",
  "assistantSources.manualChecklist.pickItems": {
    one: "{count} пункт",
    many: "{count} пунктов",
    other: "{count} пункта",
  },
  "assistantSources.manualChecklist.pickNone": "Чек-лист не открыт",
  "assistantSources.lens.description": "Количество элементов, соответствующих каждому правилу активной схемы отображения, с примерами.",
  "assistantSources.lens.rows": "Каждая строка содержит правило схемы отображения или значение автоматического окрашивания и число соответствующих элементов по встроенному расчёту.",
  "assistantSources.lens.unavailable": "На момент фиксации данных не было активной рассчитанной схемы отображения. Активируйте схему и обновите подтверждающие данные.",
  "assistantSources.lens.suggestSummary": "Объясните, что отображает активная схема отображения и какие правила соответствуют наибольшему числу элементов",
  "assistantSources.lens.pickRules": {
    one: "{name} · {count} правило",
    many: "{name} · {count} правил",
    other: "{name} · {count} правила",
  },
  "assistantSources.lens.pickNone": "Нет активной схемы отображения",
  "assistantSources.lens.pickPending": "Вычисление…",
  "assistantSources.bcf.description": "Темы загруженного проекта BCF: статус, приоритет, назначение и связанные элементы.",
  "assistantSources.bcf.rows": "Каждая строка содержит одну тему BCF. Текст комментариев и снимки не включаются.",
  "assistantSources.bcf.unavailable": "На момент фиксации данных проект BCF не был загружен. Откройте или создайте темы BCF и обновите подтверждающие данные.",
  "assistantSources.bcf.suggestSummary": "Обобщите открытые темы по статусу и приоритету",
  "assistantSources.bcf.suggestPriorities": "Какие темы следует разрешить в первую очередь и кому они назначены?",
  "assistantSources.bcf.pickTopics": {
    one: "{count} тема",
    many: "{count} тем",
    other: "{count} темы",
  },
  "assistantSources.bcf.pickNone": "Проект BCF отсутствует",
} satisfies Catalogue;
