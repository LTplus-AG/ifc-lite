/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const storeyManagerRu = {
  "storeyManager.title": "Этажи",
  "storeyManager.subtitle": "{model} · этажей: {count}",
  "storeyManager.open": "Управление этажами…",
  "storeyManager.back": "Назад к инспектору",
  "storeyManager.undoLabel": "Изменение этажа",
  "storeyManager.addAbove": "Добавить этаж выше",
  "storeyManager.addBelow": "Добавить этаж ниже",
  "storeyManager.addAboveOf": "Добавить этаж над {storey}",
  "storeyManager.addBelowOf": "Добавить этаж под {storey}",
  "storeyManager.fallbackName": "Уровень {index}",
  "storeyManager.added": "{storey} добавлен на отметке {elevation} м",
  "storeyManager.renamed": "Переименовано в {storey}",
  "storeyManager.column.name": "Имя",
  "storeyManager.column.elevation": "Отметка",
  "storeyManager.column.height": "Высота этажа",
  "storeyManager.column.elements": "Элементы",
  "storeyManager.elements": {
    "one": "{count} элемент",
    "few": "{count} элемента",
    "many": "{count} элементов",
    "other": "{count} элемента"
  },
  "storeyManager.active": "Рисование здесь",
  "storeyManager.activeGroup": "Этаж для рисования",
  "storeyManager.activate": "Рисовать на {storey}",
  "storeyManager.noStoreyAbove": "Верхний этаж: выше нет этажа, до которого можно измерить",
  "storeyManager.field.name": "Имя {storey}",
  "storeyManager.field.elevation": "Отметка {storey}, метры",
  "storeyManager.field.height": "Высота этажа {storey}, метры",
  "storeyManager.field.hint": "Enter применяет · Esc отменяет",
  "storeyManager.invalid.name": "У этажа должно быть имя",
  "storeyManager.invalid.length": "Введите длину, например 3.00, 3,5 или 3500 mm",
  "storeyManager.invalid.height": "Введите высоту больше нуля, например 3.00 или 3500 mm",
  "storeyManager.mode.elevation": "Перемещает только {storey}; этажи выше остаются на месте",
  "storeyManager.mode.height": "Сдвигает все этажи над {storey} на одну величину",
  "storeyManager.impact.title": "Что изменится",
  "storeyManager.impact.storeys": {
    "one": "Перемещает {count} этаж",
    "few": "Перемещает {count} этажа",
    "many": "Перемещает {count} этажей",
    "other": "Перемещает {count} этажа"
  },
  "storeyManager.impact.elements": {
    "one": "перемещает {count} элемент",
    "few": "перемещает {count} элемента",
    "many": "перемещает {count} элементов",
    "other": "перемещает {count} элемента"
  },
  "storeyManager.impact.walls": {
    "one": "меняет высоту {count} стены",
    "few": "меняет высоту {count} стен",
    "many": "меняет высоту {count} стен",
    "other": "меняет высоту {count} стен"
  },
  "storeyManager.impact.stairs": {
    "one": "перестраивает {count} лестницу",
    "few": "перестраивает {count} лестницы",
    "many": "перестраивает {count} лестниц",
    "other": "перестраивает {count} лестницы"
  },
  "storeyManager.impact.held": {
    "one": "удерживает на месте {count} элемент другого этажа",
    "few": "удерживает на месте {count} элемента других этажей",
    "many": "удерживает на месте {count} элементов других этажей",
    "other": "удерживает на месте {count} элемента других этажей"
  },
  "storeyManager.impact.nothing": "Ничего не перемещается: этаж уже там",
  "storeyManager.impact.preview": "Показано в 3D и на плане до применения",
  "storeyManager.impact.planOnly": "В общей комнате предпросмотр не показывается всем: Enter применяет изменение",
  "storeyManager.notice.wallNotResized": {
    "one": "{count} привязанная стена перемещается, но сохраняет высоту: это не простое выдавливание",
    "few": "{count} привязанные стены перемещаются, но сохраняют высоту: это не простые выдавливания",
    "many": "{count} привязанных стен перемещаются, но сохраняют высоту: это не простые выдавливания",
    "other": "{count} привязанные стены перемещаются, но сохраняют высоту: это не простые выдавливания"
  },
  "storeyManager.notice.wallAttachmentUnresolved": {
    "one": "{count} стена сохраняет высоту: её привязка верха не указывает на один этаж",
    "few": "{count} стены сохраняют высоту: их привязка верха не указывает на один этаж",
    "many": "{count} стен сохраняют высоту: их привязка верха не указывает на один этаж",
    "other": "{count} стены сохраняют высоту: их привязка верха не указывает на один этаж"
  },
  "storeyManager.notice.stairNotRefit": {
    "one": "{count} лестница перемещается, но не перестраивается: это не одиночный марш",
    "few": "{count} лестницы перемещаются, но не перестраиваются: это не одиночные марши",
    "many": "{count} лестниц перемещаются, но не перестраиваются: это не одиночные марши",
    "other": "{count} лестницы перемещаются, но не перестраиваются: это не одиночные марши"
  },
  "storeyManager.notice.select": "Выбрать",
  "storeyManager.refusal.spacing": "Между {storey} и {neighbour} не останется высоты",
  "storeyManager.refusal.crossingAbove": "{storey} окажется выше этажа {neighbour} ({neighbourElevation} м)",
  "storeyManager.refusal.crossingBelow": "{storey} окажется ниже этажа {neighbour} ({neighbourElevation} м)",
  "storeyManager.refusal.topStorey": "{storey} — верхний этаж: выше нет этажа, до которого можно измерить",
  "storeyManager.refusal.shared": {
    "one": "{count} элемент делит размещение с другим этажом и не может переместиться отдельно",
    "few": "{count} элемента делят размещения с другим этажом и не могут переместиться отдельно",
    "many": "{count} элементов делят размещения с другим этажом и не могут переместиться отдельно",
    "other": "{count} элемента делят размещения с другим этажом и не могут переместиться отдельно"
  },
  "storeyManager.refusal.unplaced": {
    "one": "У {count} элемента есть геометрия, но нет размещения, поэтому он не может переместиться",
    "few": "У {count} элементов есть геометрия, но нет размещения, поэтому они не могут переместиться",
    "many": "У {count} элементов есть геометрия, но нет размещения, поэтому они не могут переместиться",
    "other": "У {count} элементов есть геометрия, но нет размещения, поэтому они не могут переместиться"
  },
  "storeyManager.refusal.unreadable": {
    "one": "У {count} элемента размещение не читается",
    "few": "У {count} элементов размещения не читаются",
    "many": "У {count} элементов размещения не читаются",
    "other": "У {count} элементов размещения не читаются"
  },
  "storeyManager.refusal.onlyStorey": "В модели остаётся хотя бы один этаж",
  "storeyManager.refusal.stale": "Модель изменилась после проверки. Проверьте ещё раз, прежде чем подтвердить.",
  "storeyManager.refusal.tooLarge": "{storey}: слишком много элементов, чтобы изменить этаж за один шаг",
  "storeyManager.refusal.other": "Не применено: {reason}",
  "storeyManager.refusal.nothingChanged": "Ничего не изменено.",
  "storeyManager.delete": "Удалить {storey}",
  "storeyManager.deleted": "{storey} удалён",
  "storeyManager.undo": "Отменить",
  "storeyManager.delete.title": {
    "one": "{storey} содержит {count} элемент",
    "few": "{storey} содержит {count} элемента",
    "many": "{storey} содержит {count} элементов",
    "other": "{storey} содержит {count} элемента"
  },
  "storeyManager.delete.moveTo": "Переместить на",
  "storeyManager.delete.move": "Переместить и удалить",
  "storeyManager.delete.withContents": {
    "one": "Удалить вместе с {count} элементом",
    "few": "Удалить вместе с {count} элементами",
    "many": "Удалить вместе с {count} элементами",
    "other": "Удалить вместе с {count} элементами"
  },
  "storeyManager.delete.cancel": "Оставить этаж",
  "storeyManager.strip.label": "Этажи в масштабе",
  "storeyManager.strip.level": "{storey} на отметке {elevation} м",
  "storeyManager.loading": "Чтение этажей…",
  "storeyManager.empty": "В этой модели пока нет этажей",
  "storeyManager.addFirst": "Добавить этаж на ±0.00",
  "storeyManager.noModel": "Откройте модель в рабочей области моделирования, чтобы управлять этажами",
  "storeyManager.readOnly": "Этажи можно просматривать, но не изменять: {reason}",
  "storeyManager.error": "Не удалось прочитать этажи: {reason}"
} satisfies Catalogue;
