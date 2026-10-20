/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const flowStartupRu = {
  "flowStartup.optIn": "Предлагать этот рабочий процесс при запуске",
  "flowStartup.title": "Открыть сохранённый сценарий?",
  "flowStartup.description": "Откройте “{name}”, чтобы выбрать файлы и проверить настройки, затем нажмите Запустить, когда будете готовы.",
  "flowStartup.open": "Открыть сценарий",
  "flowStartup.skip": "Пропустить эту сессию",
  "flowStartup.disable": "Отключить предложение при запуске",
  "flowStartup.storageError": "Не удалось сохранить настройки автозапуска: {reason}",
} satisfies Catalogue;
