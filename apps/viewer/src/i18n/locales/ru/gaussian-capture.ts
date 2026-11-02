/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const gaussianCaptureRu = {
  "gaussianCapture.kind": "Гауссов захват (внутренний предпросмотр)",
  "gaussianCapture.format.gaussianPly": "Gaussian PLY",
  "gaussianCapture.format.splat": ".splat",
  "gaussianCapture.heading.capture": "Захват",
  "gaussianCapture.heading.limitations": "Ограничения",
  "gaussianCapture.splats": "Сплаты",
  "gaussianCapture.shDegree": "Степень сферических гармоник",
  "gaussianCapture.placement": "Размещение",
  "gaussianCapture.placement.source": "Исходные координаты источника",
  "gaussianCapture.placement.explicit": "Явно заданное размещение",
  "gaussianCapture.calibration": "Калибровка",
  "gaussianCapture.calibration.uncalibrated": "Не откалиброван: без единиц, привязки и измерений",
  "gaussianCapture.rendererState": "Состояние рендерера",
  "gaussianCapture.state.resident": "Загружен на GPU",
  "gaussianCapture.state.pending": "Ожидание графического устройства",
  "gaussianCapture.state.failedReload": "Загрузка не удалась. Перезагрузите захват.",
  "gaussianCapture.state.failedAnchor": "Его размещение находится дальше 8 192 м от общей опорной точки гауссианов, поэтому он больше не отображается. Исправьте размещение модели, затем перезагрузите захват.",
  "gaussianCapture.state.failedOther": "Ошибка ({reason}). Перезагрузите захват.",
  "gaussianCapture.state.replaced": "Рендерер просмотрщика перезапущен. Перезагрузите захват.",
  "gaussianCapture.state.invalid": "Отсутствует в этом рендерере. Перезагрузите захват.",
  "gaussianCapture.scale": "Масштаб",
  "gaussianCapture.scale.unknown": "Неизвестен: единицы источника, не метры",
  "gaussianCapture.attribution": "Авторство",
  "gaussianCapture.limitation.clipping": "Секущие плоскости и рамки отсекают гауссианы целиком по центру; без заливки разреза.",
  "gaussianCapture.limitation.composition": "Наложение поверх стекла IFC и рентген-режима приблизительное.",
  "gaussianCapture.limitation.picking": "Не выбирается щелчком: выберите захват в списке моделей. Без привязки и измерений.",
  "gaussianCapture.row.summary": { one: "{formatted} сплат · не откалиброван", few: "{formatted} сплата · не откалиброван", many: "{formatted} сплатов · не откалиброван", other: "{formatted} сплата · не откалиброван" },
  "gaussianCapture.row.inspect": "Показать сведения о захвате",
  "gaussianCapture.row.hide": "Скрыть захват",
  "gaussianCapture.row.show": "Показать захват",
  "gaussianCapture.row.fit": "Вписать захват в вид",
  "gaussianCapture.row.remove": "Удалить захват",
  "gaussianCapture.row.reload": "Перезагрузить захват",
  "gaussianCapture.reload.sourceUnavailable": "Файл захвата больше недоступен. Откройте его снова.",
  "gaussianCapture.reload.notLoaded": "Захват не удалось загрузить повторно.",
} satisfies Catalogue;
