/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const assistantPackMeasureRu = {
  "assistantSources.measurements.description": "Завершённые 3D-расстояния, полилинии, углы и аппроксимации радиуса, каждое со своим типом и единицей измерения.",
  "assistantSources.measurements.rows": "Строки представляют собой окончательные измерения. Виды и единицы измерения никогда не суммируются; устаревшие строки предшествуют перемещению модели.",
  "assistantSources.measurements.unavailable": "На момент фиксации данных завершённых измерений не было. Выполните измерения в средстве просмотра и обновите подтверждающие данные.",
  "assistantSources.measurements.ready": {
    one: "{count} измерение",
    many: "{count} измерений",
    other: "{count} измерения",
  },
  "assistantSources.measurements.none": "Нет готовых измерений",
  "assistantSources.measurements.suggestExplain": "Обобщите эти измерения по видам",
  "assistantSources.measurements.suggestStale": "Какие измерения устарели и почему?",
  "assistantSources.drawingMeasurements.title": "Измерения на чертёже",
  "assistantSources.drawingMeasurements.description": "Расстояния и площади, измеренные на двухмерном чертёже, указаны в метрах и квадратных метрах.",
  "assistantSources.drawingMeasurements.rows": "Строки представляют измерения расстояний и площадей на чертёже. Они не связаны с сечением, на котором были нанесены.",
  "assistantSources.drawingMeasurements.unavailable": "При фиксации данных измерений на чертёже не было. Выполните измерения на 2D-чертёже и обновите данные.",
  "assistantSources.drawingMeasurements.ready": {
    one: "{count} измерение на чертёже",
    many: "{count} измерений на чертёже",
    other: "{count} измерения на чертёже",
  },
  "assistantSources.drawingMeasurements.none": "Нет измерений на чертёже",
  "assistantSources.drawingMeasurements.suggestExplain": "Подведите итог измеренным расстояниям и площадям",
  "assistantSources.deviation.title": "Отклонение скана",
  "assistantSources.deviation.description": "Статистика отклонений BIM от скана по каждому скану, в метрах.",
  "assistantSources.deviation.rows": "Строки представляют сканы со статистикой их отклонений. Сводные показатели охватывают каждую точку, а не среднее значение по строкам.",
  "assistantSources.deviation.unavailable": "При фиксации данных статистика отклонений отсутствовала. Вычислите отклонения в панели Облака точек и обновите данные.",
  "assistantSources.deviation.ready": {
    one: "{count} скан",
    many: "{count} сканов",
    other: "{count} скана",
  },
  "assistantSources.deviation.reading": "Чтение статистики отклонений",
  "assistantSources.deviation.none": "Отклонение не вычислено",
  "assistantSources.deviation.suggestExplain": "Объясните, насколько скан отклоняется от модели",
  "assistantSources.deviation.suggestTolerance": "Какие сканы выходят за пределы допуска?",
} satisfies Catalogue;
