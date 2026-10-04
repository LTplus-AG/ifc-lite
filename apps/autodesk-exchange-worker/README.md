# Autodesk Data Exchange worker

A Windows .NET 8 process using the published Autodesk Data Exchange SDK 8.0.0 to export a user's current exchange as IFC. It receives a delegated access token on stdin from the authenticated service. It does not need an application secret, prompt for a second login, or persist OAuth tokens.

Build on Windows with `dotnet publish apps/autodesk-exchange-worker/AutodeskExchangeWorker.csproj -c Release -p:RestoreLockedMode=true`. Set `AUTODESK_EXCHANGE_WORKER` to the absolute published executable path in the Node service. Run the service on the same Windows host to enable both native adapters; build the Rust Forma converter for Windows and set `AUTODESK_FORMA_CONVERTER` to its executable. Reverse-proxy that service on the viewer's HTTPS origin. The SDK includes native Windows dependencies; a Linux container cannot run the exchange worker.

Each import starts a fresh process in a private scratch directory. SDK caches and logs stay in that directory, removed after completion. Cancellation terminates the process tree. The service limits concurrent imports. The worker verifies the selected Docs version and the SDK's exchange snapshot before and after export, and refuses a changed exchange. Autodesk's whole-exchange export API has no historical revision parameter, so historical exchange versions are shown in the UI for reference with export disabled.

Compilation runs in the Windows CI lane without credentials. A successful build does not qualify Autodesk's cloud exporter: live verification needs a provisioned APS app and a user's actual exchange. Check geometry, units, coordinates and parameters against that source before describing export fidelity. The SDK's terms apply to deployment; no SDK binaries are committed to this repository.
