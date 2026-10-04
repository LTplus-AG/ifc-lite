/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
internal static class SnapshotGuard
{
    public static void CurrentVersion(string selected, string actual)
    {
        if (string.IsNullOrWhiteSpace(selected) || selected != actual)
            throw new InvalidOperationException("Selected exchange is no longer current");
    }
    public static void UnchangedSnapshot(string before, string after)
    {
        if (string.IsNullOrWhiteSpace(before) || before != after)
            throw new InvalidOperationException("Exchange changed during export");
    }
    public static string ArtifactPath(string directory, string artifact)
    {
        var root = Path.GetFullPath(directory) + Path.DirectorySeparatorChar;
        var path = Path.GetFullPath(artifact);
        if (!path.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException();
        return path;
    }
    public static void SelfTest()
    {
        var root = Path.Combine(Path.GetTempPath(), "ifclite-guard-test");
        var valid = Path.Combine(root, "output", "model.ifc");
        if (ArtifactPath(root, valid) != Path.GetFullPath(valid)) throw new InvalidOperationException();
        RequireFailure(() => ArtifactPath(root, Path.Combine(root + "-other", "model.ifc")));
        RequireFailure(() => ArtifactPath(root, Path.Combine(root, "..", "model.ifc")));
        RequireFailure(() => CurrentVersion("historical", "current"));
        RequireFailure(() => UnchangedSnapshot("snapshot-1", "snapshot-2"));
        RequireFailure(() => UnchangedSnapshot("", ""));
        CurrentVersion("selected", "selected"); UnchangedSnapshot("immutable", "immutable");
    }
    private static void RequireFailure(Action operation)
    {
        try { operation(); }
        catch (InvalidOperationException) { return; }
        catch (InvalidDataException) { return; }
        throw new Exception("Guard failed to reject invalid import");
    }
}
