/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const semanticResultsRu = {
  "semantic.resultsTitle": "Результаты SPARQL",
  "semantic.resultsPrevious": "Предыдущие строки",
  "semantic.resultsNext": "Следующие строки",
  "semantic.resultsPage": "Строки {start}–{end} из {count}",
  "semantic.resultsUnbound": "Несвязанный",
  "semantic.resultsSelect": "Выбрать сопоставленную строку",
  "semantic.resultsCandidates": "Выбрать модель-кандидат",
  "semantic.resultsChoose": "Выбрать {model}, сущность {id}",
  "semantic.resultsStatus": "Сопоставление с IFC",
  "semantic.resultsResolved": "Сопоставлено",
  "semantic.resultsAmbiguous": "Неоднозначно",
  "semantic.resultsUnmatched": "Не сопоставлено",
  "semantic.resultsUnscoped": "Несвязанная ревизия",
  "semantic.resultsExternal": "Идентификатор IFC отсутствует",
  "semantic.resultsInvalid": "Некорректный идентификатор",
  "semantic.resultsStale": "Кандидат больше недоступен; сопоставьте строку повторно",
} satisfies Catalogue;
