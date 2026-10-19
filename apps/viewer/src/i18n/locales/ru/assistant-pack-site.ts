/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const assistantPackSiteRu = {
  "assistantSources.zones.description": "В какую зону попадает каждый элемент, с его объёмом по сетке в каждой зоне и причиной отсутствия объёма",
  "assistantSources.zones.rows": "Каждая строка представляет один элемент в одной зоне, до которой он доходит, с указанием его доли объёма",
  "assistantSources.zones.unavailable": "Назначение зон недоступно. Создайте набор зон и дождитесь, пока элементы будут назначены.",
  "assistantSources.zones.suggestSummary": "Кратко опишите, как элементы распределены по зонам",
  "assistantSources.zones.suggestUnmeasured": "Какие элементы не имеют измеренного объёма и почему?",
  "assistantSources.zones.noSets": "Нет наборов зон",
  "assistantSources.zones.notAssigned": "Элементы ещё не назначены",
  "assistantSources.zones.ready": {
    one: "{count} набор зон",
    many: "{count} наборов зон",
    other: "{count} набора зон",
  },
  "assistantSources.placement.description": "Смещение и направление каждой модели в рабочей области, её геопривязка и возможная двойная геопривязка",
  "assistantSources.placement.rows": "Каждая строка представляет одну загруженную модель с её размещением и геопривязкой",
  "assistantSources.placement.unavailable": "Модель не загружена, поэтому обсуждать размещение нечего.",
  "assistantSources.placement.suggestAlignment": "Размещены ли загруженные модели согласованно друг с другом?",
  "assistantSources.placement.suggestGeoref": "Объясните геопривязку каждой модели и всё, что выглядит неверным",
  "assistantSources.layerDiff.title": "Изменения слоёв",
  "assistantSources.layerDiff.description": "Что добавляет, изменяет и удаляет один слой IFCX в составном стеке",
  "assistantSources.layerDiff.rows": "Каждая строка представляет собой один из путей, добавленных, изменённых или удалённых слоём",
  "assistantSources.layerDiff.unavailable": "Изменения слоя не вычислены. Сначала откройте изменения слоя на панели Слои.",
  "assistantSources.layerDiff.suggestSummary": "Кратко опишите, что изменяет этот слой",
  "assistantSources.layerDiff.suggestReview": "Что должен проверить рецензент, прежде чем принять этот слой?",
  "assistantSources.layerDiff.noStack": "Стек слоёв не загружен",
  "assistantSources.layerDiff.running": "Расчёт изменений слоёв",
  "assistantSources.layerDiff.notRun": "Изменения слоёв не открыты",
  "assistantSources.layerDiff.ready": {
    one: "{count} изменение",
    many: "{count} изменений",
    other: "{count} изменения",
  },
  "assistantSources.selection.title": "Выбранное",
  "assistantSources.selection.description": "Выбранные элементы с их атрибутами, наборами свойств и количественными характеристиками, включая правки",
  "assistantSources.selection.rows": "Каждая строка представляет собой один выбранный элемент, как это отображается на панели Свойства",
  "assistantSources.selection.unavailable": "Ничего не выделено. Сначала выберите один или несколько элементов.",
  "assistantSources.selection.suggestExplain": "Объясните, что выбрано и что в этом примечательного",
  "assistantSources.selection.suggestCompare": "Чем отличаются выбранные элементы друг от друга?",
  "assistantSources.selection.none": "Ничего не выбрано",
  "assistantSources.selection.ready": {
    one: "{count} элемент выбран",
    few: "{count} элемента выбраны",
    many: "{count} элементов выбрано",
    other: "{count} элемента выбрано",
  },
} satisfies Catalogue;
