/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const viewerShellRu = {
  "viewerShell.chunkError.loadFailed": "{label} не удалось загрузить",
  "viewerShell.chunkError.crashed": "{label} больше не работает",
  "viewerShell.chunkError.loadFailedDetail": "Обычно это означает, что приложение было обновлено, пока ваша вкладка была открыта.",
  "viewerShell.chunkError.crashedDetail": "Непредвиденная ошибка помешала отображению.",
  "viewerShell.chunkError.reload": "Перезагрузить",
  "viewerShell.staleDeployment.notice": "Доступна новая версия просмотрщика — перезагрузите для продолжения.",
  "viewerShell.staleDeployment.reopenPrompt": "Программа просмотра обновилась до новой версии и перезагрузилась. Откройте {files} снова, чтобы продолжить.",
  "viewerShell.staleDeployment.reopenAction": "Открыть файл…",
  "viewerShell.hostConfig.errorTitle": "Не удалось запустить средство просмотра",
  "viewerShell.hostConfig.errorBody": "Не удалось загрузить его настройки, поэтому ничего не показано. Перезагрузите страницу. Если проблема повторяется, сообщите об этом владельцам сайта.",
  "viewerShell.hostConfig.viewerLoadTitle": "Не удалось загрузить средство просмотра",
  "viewerShell.hostConfig.viewerLoadBody": "Не удалось загрузить его программные файлы, поэтому ничего не показано. Перезагрузите страницу. Если проблема повторяется, сообщите об этом владельцам сайта.",
  "viewerShell.hostConfig.errorDetail": "Техническая деталь: {detail}",
  "viewerShell.chunkLabel.appearancePanel": "Панель внешнего вида",
  "viewerShell.chunkLabel.chartsPanel": "Панель диаграмм",
  "viewerShell.chunkLabel.flowPanel": "Панель Сценарии",
  "viewerShell.chunkLabel.drawingPanel": "Чертёжная панель",
  "viewerShell.chunkLabel.documentPanel": "Панель документа",
  "viewerShell.chunkLabel.presentationPanel": "Панель презентаций",
  "viewerShell.chunkLabel.layersPanel": "Панель слоёв",
  "viewerShell.chunkLabel.mcpPage": "Страница MCP",
  "viewerShell.chunkLabel.mcpPlayground": "Тестовая среда MCP",
  "viewerShell.chunkLabel.rteGpuWitness": "Контрольный тест RTE на GPU",
  "viewerShell.dialog.close": "Закрыть",
  "viewerShell.dialog.confirmTitle": "Подтвердить действие",
  "viewerShell.dialog.promptTitle": "Ввести значение",
  "viewerShell.dialog.promptValue": "Значение",
  "viewerShell.dialog.cancel": "Отменить",
  "viewerShell.dialog.confirm": "Подтвердить",
  "viewerShell.file.ifcxOverlayRequiresIfcx": "Файлы наложения IFCX нельзя добавить в модели IFC4. Загружайте файлы IFCX отдельно.",
  "viewerShell.toast.dismiss": "Закрыть уведомление",
} satisfies Catalogue;
