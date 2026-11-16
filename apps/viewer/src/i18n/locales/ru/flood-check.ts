/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const floodCheckRu = {
  "floodCheck.section.title": "Поверхностный сток",
  "floodCheck.section.intro": "Проверяет двери, окна, проёмы и оборудование у земли по федеральной карте опасности поверхностного стока (BAFU): какие из них находятся в пределах или ниже класса глубины, нанесённого рядом.",
  "floodCheck.section.screeningOnly": "Предварительная проверка по опубликованной карте опасности, а не моделирование наводнения. Карта не имеет юридической силы, и участки, показанные незатронутыми, всё же могут быть затронуты.",
  "floodCheck.section.showHazard": "Наложить карту поверхностного стока на рельеф",
  "floodCheck.section.hazardNeedsTerrain": "Загрузите рельеф окружения выше, чтобы увидеть на нём карту.",
  "floodCheck.section.hazardFailed": "Не удалось наложить карту поверхностного стока: {reason}",
  "floodCheck.section.groundStorey": "Первый этаж",
  "floodCheck.section.groundStoreyGuess": "Не указан (проверка угадывает)",
  "floodCheck.section.groundStoreyGuessNote": "Угаданный первый этаж может оказаться подвалом, поэтому ни один элемент не получит благоприятного результата. Укажите его, чтобы это стало возможно.",
  "floodCheck.section.run": "Запустить проверку",
  "floodCheck.section.rerun": "Проверить снова",
  "floodCheck.section.cancel": "Отмена",
  "floodCheck.section.running": "Чтение модели, карты опасности и рельефа…",
  "floodCheck.section.refused": "Проверка отказала: {reason}",
  "floodCheck.outcome.exposed": "Под угрозой",
  "floodCheck.outcome.openEnded": "Класс глубины без верхней границы",
  "floodCheck.outcome.withinRange": "В пределах класса",
  "floodCheck.outcome.aboveRange": "Выше нанесённых классов",
  "floodCheck.outcome.noRunoffMapped": "Сток не нанесён (не «безопасно»)",
  "floodCheck.outcome.unclassified": "Не установлено",
  "floodCheck.summary.checked": "Проверено элементов: {count}",
  "floodCheck.summary.noRunoffNotSafe": "«Сток не нанесён» означает, что карта не показывает его рядом с элементом. Это не значит, что элемент в безопасности.",
  "floodCheck.summary.showColours": "Окрасить проверенные элементы по результату",
  "floodCheck.summary.selectHint": "Выберите элемент, чтобы увидеть его результат и набор свойств.",
  "floodCheck.summary.heightConfirmed": "Высотная привязка проверена по рельефу у дверей первого этажа.",
  "floodCheck.summary.heightUnconfirmed": "Высотная привязка не подтверждена, поэтому ни один элемент не получает благоприятного результата: {reasons}.",
  "floodCheck.summary.notes": "Примечания и оговорки ({count})",
  "floodCheck.summary.disclaimer": "Оговорка и ограничения издателя",
  "floodCheck.summary.source": "Источник: {source}. Данные от {date}.",
  "floodCheck.summary.requests": "Запросов: {requests}, {size}",
  "floodCheck.legend.hazardTitle": "Карта поверхностного стока (BAFU), глубина потока",
  "floodCheck.legend.hazardCaveat": "Моделирование, редкие и очень редкие события. Не имеет юридической силы; неотмеченные участки тоже могут быть затронуты.",
  "floodCheck.legend.verdictTitle": "Проверка на подтопление",
  "floodCheck.legend.verdictCaveat": "Угроза определена по опубликованной карте опасности. Не моделирование наводнения.",
  "floodCheck.card.heading": "Проверка поверхностного стока",
  "floodCheck.card.notInModel": "Из проверки, выполненной в этом сеансе; в модель не записано.",
} satisfies Catalogue;
