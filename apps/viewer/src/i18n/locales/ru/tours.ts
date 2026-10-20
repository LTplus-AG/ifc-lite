/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const toursRu = {
  "tours.learnTab.description": "Интерактивные пошаговые инструкции запускаются на вашей модели или на прилагаемом демонстрационном проекте. Каждый шаг можно пропустить.",
  "tours.learnTab.completedAriaLabel": "Завершено",
  "tours.learnTab.replay": "Повторить",
  "tours.learnTab.start": "Начать",
  "tours.learnTab.minutes": "{count} мин",
  "tours.panelTourButton.startAriaLabel": "Начать тур: {title}",
  "tours.panelTourButton.tooltip": "{title} (тур на {count} мин)",
  "tours.tourHost.prereqAriaLabel": "{title}: предварительные требования",
  "tours.tourHost.prereqLayerStack": "Для этого тура требуется структурированный стек слоёв. Загрузите демонстрационный стек (три крошечных слоя), чтобы следовать инструкциям.",
  "tours.tourHost.prereqSecondModel": "Для этого тура необходимо загрузить две версии модели. Загрузите демонстрационный проект, чтобы следовать инструкциям.",
  "tours.tourHost.prereqModel": "Для этого тура необходима загруженная модель. Загрузите демонстрационный проект, чтобы следовать инструкциям, или сначала откройте свой собственный IFC-файл.",
  "tours.tourHost.cancel": "Отменить",
  "tours.tourHost.loadDemoStack": "Загрузить демонстрационный стек",
  "tours.tourHost.loadDemoProject": "Загрузить демонстрационный проект",
  "tours.tourInvite.prompt": "Вы здесь впервые?",
  "tours.tourInvite.start": "Пройдите двухминутную экскурсию",
  "tours.tourInvite.dismissAriaLabel": "Отклонить приглашение на тур",
  "tours.tourStepCard.ariaLabel": "Этап тура {step} из {total}: {title}",
  "tours.tourStepCard.endTourAriaLabel": "Завершить тур",
  "tours.tourStepCard.redockedNotice": "На этом этапе панель была возвращена в боковую панель.",
  "tours.tourStepCard.stuckHint": "Застряли? Пропустите этот шаг и продолжайте.",
  "tours.tourStepCard.skipStep": "Пропустить шаг",
  "tours.tourStepCard.skipUseDemo": "Пропустить (использовать демо)",
  "tours.tourStepCard.done": "Готово",
  "tours.tourStepCard.next": "Далее",
} satisfies Catalogue;
