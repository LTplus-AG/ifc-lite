/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const deviationStatsRu = {
  "deviationStats.resultSource": "Отклонение BIM ↔ скан",
  "deviationStats.readbackPopulation": {
    one: "{countDisplay} точка скана считана",
    few: "{countDisplay} точки скана считаны",
    many: "{countDisplay} точек скана считано",
    other: "{countDisplay} точки скана считано",
  },
  "deviationStats.validPopulation": "Измерено считанных точек {countDisplay} / {total}",
  "deviationStats.sourceUnknown": "Источник скана этого считывания не записан.",
  "deviationStats.assetSourceUnknown": {
    few: "Не удалось определить модели для {count} объектов сканирования.",
    many: "Не удалось определить модели для {count} объектов сканирования.",
    other: "Не удалось определить модель для {count} объекта сканирования.",
  },
  "deviationStats.assetIdentityUnknown": {
    few: "Не удалось определить IFC-идентификатор {count} объектов сканирования.",
    many: "Не удалось определить IFC-идентификатор {count} объектов сканирования.",
    other: "Не удалось определить IFC-идентификатор {count} объекта сканирования.",
  },
  "deviationStats.unmeasuredPoints": {
    few: "У {count} считанных точек нет конечного измеренного расстояния.",
    many: "У {count} считанных точек нет конечного измеренного расстояния.",
    other: "У {count} считанной точки нет конечного измеренного расстояния.",
  },
  "deviationStats.noMeasuredPoints": "В этом считывании нет конечных измеренных расстояний",
  "deviationStats.sourceAssets": "Источники считанных точек скана",
  "deviationStats.unknownAsset": "Ресурс скана не определён",
  "deviationStats.assetGlobalId": "GlobalId",
  "deviationStats.sectionLabel": "Статистика отклонений",
  "deviationStats.reading": "Расчёт статистики…",
  "deviationStats.valueMm": "{value} мм",
  "deviationStats.unitMm": "мм",
  "deviationStats.notAvailable": "—",
  "deviationStats.mean": "Среднее",
  "deviationStats.meanAbs": "Среднее значение |d|",
  "deviationStats.rms": "RMS",
  "deviationStats.stdDev": "Стандартное отклонение",
  "deviationStats.p50Abs": "P50 |d|",
  "deviationStats.p95Abs": "P95 |d|",
  "deviationStats.p99Abs": "P99 |d|",
  "deviationStats.maxAbs": "Макс. |d|",
  "deviationStats.pointsMeasured": "Измеренные точки",
  "deviationStats.toleranceLabel": "Допустимое отклонение ±",
  "deviationStats.toleranceAriaLabel": "Допустимое отклонение в миллиметрах",
  "deviationStats.withinTolerance": "{share} в пределах ±{tolerance} мм ({count} из {total})",
  "deviationStats.histogramAriaLabel": "Гистограмма отклонений со знаком от {min} до {max} мм с числом интервалов {bins}; точек ниже диапазона {below} и выше диапазона {above}",
  "deviationStats.outsideRange": "{below} ниже · {above} выше диапазона цветов",
  "deviationStats.clippedPoints": {
    one: "{countDisplay} точка достигла предела вычислений ±{clip} м; истинное расстояние больше",
    few: "{countDisplay} точки достигли предела вычислений ±{clip} м; истинное расстояние больше",
    many: "{countDisplay} точек достигли предела вычислений ±{clip} м; истинное расстояние больше",
    other: "{countDisplay} точки достигло предела вычислений ±{clip} м; истинное расстояние больше",
  },
  "deviationStats.csvAllAssetsName": "Все ресурсы сканирования",
} satisfies Catalogue;
