/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IncomingMessage, ServerResponse } from "node:http";
import { ReportError, requireCondition } from "./errors.js";
export async function body(req: IncomingMessage): Promise<unknown> {
  requireCondition(
    req.headers["content-type"]?.split(";")[0] === "application/json",
    415,
    "json_required",
    "JSON request required.",
  );
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    length += chunk.length;
    requireCondition(
      length <= 32768,
      413,
      "request_large",
      "Report text is too large.",
    );
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ReportError(400, "invalid_json", "Invalid request JSON.");
  }
}
export function json(res: ServerResponse, value: unknown, status = 200): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(value));
}
