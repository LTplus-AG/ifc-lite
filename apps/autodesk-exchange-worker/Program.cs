/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
using System.Text.Json;
using Autodesk.DataExchange;
using Autodesk.DataExchange.Core.Interface;
using Autodesk.DataExchange.Core.Models;
using Autodesk.DataExchange.Interface;

// One process per import: SDK singleton state, logs and caches belong to one user.
// Delegated access token arrives on stdin, never argv, environment or a saved file.
try
{
    if (args.Length == 1 && args[0] == "--self-test") { SnapshotGuard.SelfTest(); return; }
    if (!OperatingSystem.IsWindows()) throw new InvalidOperationException("Windows SDK worker required");
    var input = await Console.In.ReadLineAsync();
    if (input is null || input.Length > 64000) throw new InvalidDataException();
    var request = JsonSerializer.Deserialize<ExportRequest>(input) ?? throw new InvalidDataException();
    if (new[] { request.AccessToken, request.HubId, request.ProjectId, request.FileId, request.RevisionId }
        .Any(string.IsNullOrWhiteSpace)) throw new InvalidDataException();
    // Silence SDK diagnostics; only protocol JSON goes to the parent. SDK log files
    // remain within the request scratch directory, which the parent deletes.
    var protocol = Console.Out;
    Console.SetOut(TextWriter.Null);
    Console.SetError(TextWriter.Null);
    var options = new SDKOptionsDefaultSetup
    {
        // SDK derives its root via Path.Combine(AppData, ConnectorName). An absolute
        // request path keeps every SDK cache and geometry log inside scratch.
        ConnectorName = Directory.GetCurrentDirectory(),
        ConnectorVersion = "0.1.0", HostApplicationName = "IFClite", HostApplicationVersion = "0.1.0",
        AuthProvider = new DelegatedAuth(request.AccessToken)
    };
    if (Path.GetFullPath(options.ConnectorRootPath) != Path.GetFullPath(Directory.GetCurrentDirectory()))
        throw new InvalidOperationException("SDK workspace is not isolated");
    IClient client = new Client(options);
    var collection = await client.GetCollectionIdAsync(request.ProjectId, request.HubId);
    if (collection.IsFailed) throw new InvalidOperationException();
    var details = await client.GetExchangeDetailsAsync(collection.Value, request.FileId);
    if (details.IsFailed) throw new InvalidOperationException();
    SnapshotGuard.CurrentVersion(request.RevisionId, details.Value.FileVersionUrn);
    var identifier = new DataExchangeIdentifier
    {
        CollectionId = collection.Value, ExchangeId = details.Value.ExchangeID, HubId = request.HubId
    };
    var before = await client.GetLatestExchangeVersionAsync(identifier);
    if (before.IsFailed) throw new InvalidOperationException();
    using var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(12));
    var artifact = client.DownloadCompleteExchangeAsIFC(identifier, Directory.GetCurrentDirectory(), timeout.Token);
    if (artifact.IsFailed) throw new InvalidOperationException();
    var after = await client.GetLatestExchangeVersionAsync(identifier);
    var refreshed = await client.GetExchangeDetailsAsync(collection.Value, request.FileId);
    if (after.IsFailed || refreshed.IsFailed) throw new InvalidOperationException();
    SnapshotGuard.UnchangedSnapshot(before.Value, after.Value);
    SnapshotGuard.CurrentVersion(request.RevisionId, refreshed.Value.FileVersionUrn);
    var path = SnapshotGuard.ArtifactPath(Directory.GetCurrentDirectory(), artifact.Value);
    if (!File.Exists(path)) throw new InvalidDataException();
    await protocol.WriteLineAsync(JsonSerializer.Serialize(new { revisionId = request.RevisionId, path }));
}
catch (Exception)
{
    // No SDK exception strings: they may contain upstream requests or credentials.
    Environment.ExitCode = 1;
}

internal sealed record ExportRequest(string AccessToken, string HubId, string ProjectId, string FileId, string RevisionId);
internal sealed class DelegatedAuth(string token) : IAuth
{
    public Task<string> GetAuthTokenAsync() => Task.FromResult(token);
    // BFF obtains a fresh token before launching. Never open a second login flow.
    public string GetAuthToken(bool isForceRefresh = false) => token;
    public async Task<UserAccount> GetUserAccountAsync()
    {
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
        using var request = new HttpRequestMessage(HttpMethod.Get, "https://developer.api.autodesk.com/authentication/v2/userinfo");
        request.Headers.Authorization = new("Bearer", token);
        using var response = await http.SendAsync(request);
        response.EnsureSuccessStatusCode();
        using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        var user = json.RootElement;
        return new UserAccount
        {
            UserId = user.GetProperty("sub").GetString(),
            Email = user.TryGetProperty("email", out var email) ? email.GetString() : "",
            FirstName = user.TryGetProperty("given_name", out var first) ? first.GetString() : "",
            LastName = user.TryGetProperty("family_name", out var last) ? last.GetString() : ""
        };
    }
}
