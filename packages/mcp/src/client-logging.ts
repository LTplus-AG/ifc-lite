/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * MCP logging: `logging/setLevel` picks a minimum severity, and every server
 * log line at or above it also goes to the client as `notifications/message`.
 * Nothing is forwarded until the client sets a level, so clients that never
 * ask get no log traffic.
 */

import { LOGGING_LEVELS, type LoggingLevel, type LogNotification } from './protocol/index.js';
import type { Logger } from './context.js';

export function isLoggingLevel(value: unknown): value is LoggingLevel {
  return typeof value === 'string' && (LOGGING_LEVELS as readonly string[]).includes(value);
}

export class ClientLogForwarder {
  private minimum: number | null = null;

  constructor(
    private readonly base: Logger,
    private readonly loggerName: string,
    private readonly send: (params: LogNotification) => void,
  ) {}

  setLevel(level: LoggingLevel): void {
    this.minimum = LOGGING_LEVELS.indexOf(level);
  }

  /** The server's logger: writes to the base logger, and to the client at or above the set level. */
  readonly logger: Logger = {
    log: (level, message, data) => {
      this.base.log(level, message, data);
      if (this.minimum === null || LOGGING_LEVELS.indexOf(level) < this.minimum) return;
      this.send({ level, logger: this.loggerName, data: { ...data, message } });
    },
  };
}
