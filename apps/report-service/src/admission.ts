/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { BlockList, isIP } from "node:net";
import type { IncomingMessage } from "node:http";
export function trustedProxyList(cidrs: string[]): BlockList {
  const list = new BlockList();
  for (const cidr of cidrs) {
    const [address, prefix] = cidr.split("/");
    const version = isIP(address ?? "");
    if (!address || !version || !prefix || !/^\d+$/.test(prefix))
      throw new Error("REPORT_TRUSTED_PROXY_CIDRS must contain valid CIDRs");
    const bits = Number(prefix);
    if (bits < 0 || bits > (version === 4 ? 32 : 128))
      throw new Error("Invalid trusted proxy prefix");
    list.addSubnet(address, bits, version === 4 ? "ipv4" : "ipv6");
  }
  return list;
}
function normalized(address: string): string {
  return address.startsWith("::ffff:") && isIP(address.slice(7)) === 4
    ? address.slice(7)
    : address;
}
function trusted(list: BlockList, address: string): boolean {
  const ip = normalized(address);
  const version = isIP(ip);
  return Boolean(version && list.check(ip, version === 4 ? "ipv4" : "ipv6"));
}
/** Only traverse forwarded hops when the socket peer belongs to the explicitly
 * configured ingress CIDRs. Select nearest untrusted hop, never a client-supplied
 * leftmost XFF value. Ingress must append its observed peer on every request. */
export function admissionAddress(
  req: IncomingMessage,
  cidrs: string[],
): string {
  const remote = normalized(req.socket.remoteAddress ?? "");
  if (!isIP(remote)) throw new Error("Missing client address");
  const list = trustedProxyList(cidrs);
  if (!trusted(list, remote)) return remote;
  const header = req.headers["x-forwarded-for"];
  if (typeof header !== "string") return remote;
  const chain = header.split(",").map((v) => normalized(v.trim()));
  if (chain.length > 10 || chain.some((ip) => !isIP(ip))) return remote;
  for (let i = chain.length - 1; i >= 0; i--) {
    const ip = chain[i]!;
    if (!trusted(list, ip)) return ip;
  }
  return remote;
}
