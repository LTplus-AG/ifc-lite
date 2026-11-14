# #9523 browser evidence: local MCP bridge from a public https origin

Scripts that check how browsers treat a public https page (the viewer, as on ifclite.com) opening
`ws://127.0.0.1:<port>/` to `ifc-lite-mcp --bridge`. Not part of CI.

- `run.sh [outDir]`: from a repository root, builds the viewer and `@ifc-lite/mcp`, serves the built viewer
  behind `https-front.mjs` as `https://ifclite.test:<port>` (self-signed, resolved to 127.0.0.1, marked
  *public* for Local Network Access), then runs everything below. `SKIP_BUILD=1 REPO_BUILT=<checkout>`
  reuses an existing build; `PRINT_PNG=1` puts the screenshots into the log as base64.
- `lna-socket-probe.mjs` (Chromium), `ff-socket-probe.mjs` (Firefox): `probe.html` opens the socket under
  each permission state / pref set and reports open/close, close code and `navigator.permissions` states.
  No hello is sent, so no pairing code is consumed.
- `browser-run.mjs` + `driver.mjs`: the real viewer and the real bridge over stdio. Phase A: no permission,
  pairing link, Connect, record what the dialog says. Phase B: permission granted (Chromium: CDP
  `Browser.setPermission {name: 'loopback-network'}` in the same tab, then *Try again*; Firefox: a profile
  whose `permissions.sqlite` allows `loopback-network`), pair, read calls, a refused mutation, Disconnect.
  The run exits non-zero if the probe bridge does not start, Phase B does not connect after the grant, a read
  call fails, or the write is not refused with `READ_ONLY`.

How the origin is made public: Chromium `--ip-address-space-overrides=127.0.0.1:<port>=public`; Firefox
`network.lna.address_space.public.override=127.0.0.1:<port>` with `network.dns.localDomains=ifclite.test`.
Headless only: Chromium auto-denies the prompt, Firefox leaves it pending (its timeout is shortened to 6 s).
