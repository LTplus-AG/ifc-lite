/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { admissionAddress } from "./admission.js";
import type { Db } from "./database.js";
import type { Config } from "./config.js";
import { requireCondition } from "./errors.js";
export interface Session {
  id: string;
  csrf: string;
  admission: string;
}
export function secretEquals(left: string, right: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(left).digest(),
    createHash("sha256").update(right).digest(),
  );
}
export async function session(
  db: Db,
  config: Config,
  req: IncomingMessage,
  res: ServerResponse,
  create = false,
): Promise<Session> {
  const cookie = req.headers.cookie
    ?.split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith("__Host-ifclite_report="))
    ?.split("=")[1];
  if (cookie && /^[a-f0-9]{64}$/.test(cookie)) {
    const rows = await db.query<Session>(
      "SELECT id,csrf,admission FROM report_sessions WHERE id=$1 AND expires_at>now()",
      [createHash("sha256").update(cookie).digest("hex")],
    );
    if (rows.rows[0]) return rows.rows[0];
  }
  requireCondition(
    create,
    401,
    "session_expired",
    "Your report session expired. Start a new report.",
  );
  // Trust forwarded chains only through explicitly configured ingress peers.
  const admission = createHmac("sha256", config.admissionSecret)
    .update(admissionAddress(req, config.trustedProxyCidrs ?? []))
    .digest("hex");
  const count = await db.query<{ count: string }>(
    "SELECT count(*) FROM report_sessions WHERE admission=$1 AND expires_at>now()",
    [admission],
  );
  requireCondition(
    Number(count.rows[0]?.count) < 100,
    429,
    "session_limit",
    "Please try again later.",
  );
  const token = randomBytes(32).toString("hex");
  const result = {
    id: createHash("sha256").update(token).digest("hex"),
    csrf: randomBytes(32).toString("hex"),
    admission,
  };
  await db.query(
    "INSERT INTO report_sessions(id,csrf,admission,expires_at) VALUES($1,$2,$3,now()+interval '30 days')",
    [result.id, result.csrf, result.admission],
  );
  res.setHeader(
    "Set-Cookie",
    `__Host-ifclite_report=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`,
  );
  return result;
}
export function requireMutation(
  config: Config,
  req: IncomingMessage,
  owner: Session,
): void {
  requireCondition(
    req.headers.origin === config.origin,
    403,
    "origin",
    "This request must come from IFC Lite.",
  );
  requireCondition(
    typeof req.headers["x-csrf-token"] === "string" &&
      secretEquals(req.headers["x-csrf-token"], owner.csrf),
    403,
    "csrf",
    "Reload the reporting dialog and try again.",
  );
}
