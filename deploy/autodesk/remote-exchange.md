# Railway gateway with a Windows Data Exchange worker

The gateway can now use a remote Windows export worker. It owns the viewer's APS application, sign-in, session, source browsing and Forma conversion. The Windows service accepts only authenticated gateway jobs, invokes the existing snapshot-checked SDK exporter and returns the pinned IFC. Users do not sign in a second time. No APS application secret is installed on the worker.

## Worker setup

Use a Windows x64 host with Node 24, .NET 8, a low-privilege service account and a public DNS hostname. The Windows release bundle contains both the Node worker entry point and published SDK executable. Production requires a successful Windows bundle/SDK CI run on the same merged revision as Railway. A Linux host cannot execute the SDK.

Copy `exchange-worker.env.example` outside the release directory to an ACL-restricted configuration file. Generate a random shared key with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"` on a trusted administrator terminal; store it directly in that file and Railway's secret variable, never Git or chat. Treat the key as authorization to submit delegated user tokens and download their artifacts. The worker accepts only an exact bearer match over HTTPS.

Start the worker from the extracted production service directory:

```powershell
node --env-file=C:\IFClite\config\exchange-worker.env.local C:\IFClite\current\service\dist\exchange-worker-bin.js
```

It binds only to 127.0.0.1:3003. Configure `Caddyfile.exchange-worker` with the real IFCLITE_EXCHANGE_WORKER_HOST and run Caddy as a service. Allow inbound HTTPS only; do not expose port 3003. Keep Caddy certificate storage writable by its service account. The supplied gateway enables no access logging. Configure both processes to start on boot and restart after failure under the host's service manager. Restrict outbound access according to the SDK's Autodesk endpoints; do not guess a narrower allowlist before verifying regional SDK calls.

## Railway configuration

Add these secret/service variables to **autodesk**, leaving its local `AUTODESK_EXCHANGE_WORKER` unset:

```text
AUTODESK_EXCHANGE_WORKER_ORIGIN=https://YOUR-WINDOWS-WORKER-HOST
AUTODESK_EXCHANGE_WORKER_KEY=<same random shared key>
```

The origin must be exactly HTTPS with no path, credentials or query. Routes are fixed; redirects are refused. Invalid or half-configured worker settings refuse startup. The gateway advertises exchange import only when this adapter is installed. Configuration does not prove worker reachability or live export fidelity.

## Verification and operation

From a trusted operator client, GET `/healthz` on the worker with its bearer key. Expect JSON `{ok:true,protocol:1,imports:["exchange"]}`. Anonymous and wrong-key requests must return 401. Do not include the bearer value in shell history, screenshots or log capture. Run the viewer's deployment smoke with both `proposal` and `exchange`, then complete real sign-in and source-versus-IFC acceptance in the main rollout runbook.

The worker has two job slots covering conversion, retained results and downloads. Preparation replies 202 immediately; status is polled; downloads are bounded and artifacts are claimable once. Results expire after two minutes, active work after fifteen. Gateway cancellation/sign-out cancels its remote job; a network partition can delay cancellation until expiry. Worker restart drops jobs and interrupts imports. The worker is an independent capacity boundary shared by gateway jobs; keep one worker instance until durable shared jobs are implemented.

Only the job creation body contains the initiating user's short-lived access token; it remains in worker memory and SDK stdin, never URLs or process arguments. Scratch directories are deleted. The shared key is server-only. Rotate it by pausing new exchange imports, draining or cancelling active work, updating both services and restarting; do not keep old-key fallback authorization.

A deployed Windows host and APS app remain necessary. Local protocol tests use a controlled IFC fixture to prove authentication, revision matching, byte limits, one-time claims and cancellation; they do not establish Autodesk's real export geometry fidelity.

## Windows service templates

The bundle includes `ifclite-exchange-worker.xml` and `ifclite-exchange-gateway.xml` for [WinSW 2.x](https://github.com/winsw/winsw/blob/v2.12.0/doc/xmlConfigFile.md). Use a verified WinSW release from its official repository; the wrapper binary is not bundled. Copy each XML to `C:\IFClite\services` alongside a wrapper executable with the same basename. Update the actual Node/Caddy paths and gateway hostname before installation. Node gets secrets from its ACL-protected env file; neither XML contains a key or APS secret.

The templates use Windows' low-privilege LocalService identity on a dedicated worker VM. Grant it read/execute access to the selected release and read access to the worker env file; give it write access only to its logs, scratch/profile storage and `C:\IFClite\state`. Administrators own the release/config files. If the organization uses a separate managed service identity, update the templates and ACLs together. Do not make the services administrators or give them write access to their executables.

From an elevated operator terminal, install/start each renamed wrapper with `install` then `start`. Inspect the Windows service status and verify authenticated HTTPS health after a reboot and after an induced process failure. WinSW's stop sends Ctrl+C, allowing Node's SIGINT handler to abort native process trees; its ten-second stop timeout exceeds Node's five-second exit deadline. This service-manager lifecycle still needs verification on the actual Windows host; local XML parsing does not establish it.
