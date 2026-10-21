/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const visibilityReasonsRu = {
  "visibilityEmpty.title": "Ничего не видно: активные фильтры исключают все элементы.",
  "visibilityEmpty.reasons": "Активные причины: {reasons}",
  "visibilityEmpty.reset": "Сбросить всё",
  "visibilityReasons.hidden": "Скрытые элементы",
  "visibilityReasons.isolation": "Изолированные элементы",
  "visibilityReasons.ghost": "Контекст X-ray",
  "visibilityReasons.classFilter": "Фильтр класса",
  "visibilityReasons.storey": "Фильтр этажей или одиночный вид",
  "visibilityReasons.exploded": "Разнесённые этажи",
  "visibilityReasons.modelHidden": "Скрытые модели",
  "visibilityReasons.lens": "Активная схема отображения",
  "visibilityReasons.typeVisibility": "Скрытые классы IFC",
  "visibilityReasons.typeViewMode": "Вид Типы",
  "visibilityReasons.hostTypes": "Классы скрыты хостом",
  "visibilityReasons.section": "Сечение",
  "visibilityReasons.measurements": "Измерения",
  "visibilityChips.hiddenCount": "Скрытые элементы · {count}",
  "visibilityChips.isolationCount": "Изолированные элементы · {count}",
  "visibilityChips.ghostCount": "Контекст X-ray · {count}",
  "visibilityChips.classFilterCount": "Фильтр по классам · {count}",
  "visibilityChips.storeyCount": "Фильтр этажа · {count}",
  "visibilityChips.soloCount": {
    one: "Только · {count} этаж",
    many: "Только · {count} этажей",
    other: "Только · {count} этажа",
  },
  "visibilityChips.soloCountPlural": {
    one: "Только · {count} этаж",
    many: "Только · {count} этажей",
    other: "Только · {count} этажа",
  },
  "visibilityChips.explodedGap": "Разнесённые этажи · Зазор {gap} м",
  "visibilityChips.modelHiddenCount": "Скрыто моделей {hidden} из {total}",
  "visibilityChips.modelHiddenSingleCount": "Модель скрыта · моделей {hidden} из {total}",
  "visibilityChips.typeVisibilityCount": "Скрытые классы IFC · {count}",
  "visibilityChips.hostTypesCount": "Классы скрыты хостом · {count}",
  "visibilityChips.clearAriaLabel": "Сбросить {reason}",
  "visibilityChips.keptTooltip": "Показать всё сохраняет эту настройку. Измените её соответствующим элементом управления.",
  "visibilityChips.resetEverything": "Сбросить всё",
} satisfies Catalogue;
