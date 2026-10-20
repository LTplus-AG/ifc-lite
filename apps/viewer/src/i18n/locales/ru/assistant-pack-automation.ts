/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const assistantPackAutomationRu = {
  "assistantSources.flowRun.title": "Запуск сценария",
  "assistantSources.flowRun.description": "Последний запуск открытого графа: результаты узлов, предупреждения, выходы и артефакты.",
  "assistantSources.flowRun.rows": "Строки содержат сначала результаты узлов со сбоями (с входящими рёбрами и параметрами только для узлов со сбоями и узлов, передающих им данные; исходный код скриптов скрыт, а учётные данные удалены), затем предупреждения запуска, артефакты (только метаданные), выходы графа, результаты остальных узлов и записи журнала.",
  "assistantSources.flowRun.unavailable": "На момент фиксации данных результата выполнения сценария не было. Запустите граф в Сценариях и обновите подтверждающие данные.",
  "assistantSources.flowRun.discussRun": "Обсудить запуск с ИИ",
  "assistantSources.flowRun.suggestExplain": "Объясните, что выполнил этот запуск и что он создал",
  "assistantSources.flowRun.suggestFix": "Почему узлы выдали ошибки или предупреждения и как я могу это исправить?",
  "assistantSources.flowRun.statusRunning": "Выполняется…",
  "assistantSources.flowRun.statusOk": {
    one: "Успешно · {count} узел",
    many: "Успешно · {count} узлов",
    other: "Успешно · {count} узла",
  },
  "assistantSources.flowRun.statusFailed": {
    one: "Ошибка · {count} узел",
    many: "Ошибка · {count} узлов",
    other: "Ошибка · {count} узла",
  },
  "assistantSources.flowRun.statusError": "Выполнение завершилось с ошибкой до получения результата",
  "assistantSources.flowRun.statusNone": "Запусков пока нет",
  "assistantSources.script.description": "Результаты последнего запуска скрипта: возвращённое значение, диагностические данные и вывод в консоль.",
  "assistantSources.script.rows": "Строки содержат возвращаемое значение, диагностические данные и записи журнала. Исходный код скрипта исключён.",
  "assistantSources.script.unavailable": "На момент фиксации данных запуск скрипта был недоступен. Запустите скрипт в редакторе скриптов и обновите подтверждающие данные.",
  "assistantSources.script.suggestExplain": "Объясните, что вернул и зарегистрировал этот скрипт",
  "assistantSources.script.suggestFix": "Почему этот скрипт не сработал и как это исправить?",
  "assistantSources.script.statusRunning": "Выполняется…",
  "assistantSources.script.statusError": "Последний запуск завершился ошибкой",
  "assistantSources.script.statusResult": {
    one: "Последний запуск · {count} запись журнала",
    many: "Последний запуск · {count} записей журнала",
    other: "Последний запуск · {count} записи журнала",
  },
  "assistantSources.script.statusDiagnostics": {
    one: "{count} диагностическое сообщение",
    few: "{count} диагностических сообщения",
    many: "{count} диагностических сообщений",
    other: "{count} диагностического сообщения",
  },
  "assistantSources.script.statusNone": "Запусков пока нет",
  "assistantSources.document.description": "Блоки, привязки и параметры страницы открытого документа.",
  "assistantSources.document.rows": "Строки содержат блоки документа по порядку. Текст представляет собой шаблон без подставленных значений; для изображений и диаграмм приводятся только метаданные.",
  "assistantSources.document.unavailable": "На момент фиксации данных документ не был открыт. Откройте документ и обновите подтверждающие данные.",
  "assistantSources.document.suggestReview": "Проанализируйте структуру этого документа и предложите улучшения",
  "assistantSources.document.suggestBindings": "На какие поля модели ссылается этот документ?",
  "assistantSources.document.status": {
    one: "{name} · {count} блок",
    many: "{name} · {count} блоков",
    other: "{name} · {count} блока",
  },
  "assistantSources.document.statusNone": "Документ не открыт",
} satisfies Catalogue;
