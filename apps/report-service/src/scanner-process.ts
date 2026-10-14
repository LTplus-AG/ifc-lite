/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { spawn } from "node:child_process";

/** No shell, inherited application credentials, or raw subprocess output in errors. */
export function scannerProcess(
  args: string[],
  signal: AbortSignal,
): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        LANG: "C",
        LC_ALL: "C",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let bytes = 0;
    let overflow = false;
    const stop = () => child.kill("SIGKILL");
    const collect = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 65536) {
        overflow = true;
        stop();
        return;
      }
      output += chunk.toString("utf8");
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    child.once("error", () => {
      signal.removeEventListener("abort", stop);
      reject(new Error("scanner_process_unavailable"));
    });
    child.once("close", (code) => {
      signal.removeEventListener("abort", stop);
      if (signal.aborted || overflow || code === null)
        reject(new Error("scanner_process_interrupted"));
      else resolve({ code, output });
    });
  });
}

/** Remove only the opaque sandbox name allocated by this worker. */
export async function removeScannerContainer(name: string): Promise<void> {
  if (!/^ifclite-(?:scan|signatures)-[a-f0-9-]{36}$/.test(name))
    throw new Error("scanner_container_invalid");
  const result = await scannerProcess(
    ["rm", "--force", name],
    AbortSignal.timeout(10000),
  );
  if (result.code !== 0 && !result.output.includes("No such container"))
    throw new Error("scanner_cleanup_failed");
}
