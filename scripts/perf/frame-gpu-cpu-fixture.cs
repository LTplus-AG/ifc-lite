/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
using System;
using System.IO;
using System.Diagnostics;
using System.Globalization;
using System.Text.RegularExpressions;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;

// Controlled CPU executable, named chrome.exe only for the launcher's CIM
// name policy. This certifies neither a browser nor GPU/performance acceptance.
public static class IfcCpuFixture {
  static string Escape(string value) { return value.Replace("\\", "\\\\").Replace("\"", "\\\""); }
  static string Argument(string[] args, string prefix) {
    foreach (string argument in args) if (argument.StartsWith(prefix, StringComparison.Ordinal)) return argument.Substring(prefix.Length);
    return null;
  }
  static string Identity(Process process) {
    return "{\"pid\":" + process.Id + ",\"created\":\"" + IfcProcessIdentity.Creation(process.Handle) + "\"}";
  }
  static void AtomicWrite(string path, string value) {
    string temporary = path + ".tmp";
    File.WriteAllText(temporary, value);
    if (File.Exists(path)) File.Replace(temporary, path, null); else File.Move(temporary, path);
  }
  public static int Main(string[] args) {
    string root = Argument(args, "--fixture-root=") ?? Path.GetDirectoryName(typeof(IfcCpuFixture).Assembly.Location);
    string mode = Argument(args, "--fixture-mode=") ?? File.ReadAllText(Path.Combine(root, "fixture.mode"));
    using (Process self = Process.GetCurrentProcess()) {
      if (mode == "controller-child") {
        AtomicWrite(Path.Combine(root, "child.json"), Identity(self));
        Thread.Sleep(60000); return 0;
      }
      string profile = Argument(args, "--user-data-dir=");
      string ownerPath = mode == "controller-orphan" ? Path.Combine(root, "owner.json") : Path.Combine(profile, ".ifclite-frame-job.json");
      string prepared = File.ReadAllText(ownerPath);
      if (!Regex.IsMatch(prepared, "\"rootPid\"\\s*:\\s*" + self.Id + "\\s*(?:,|})")) throw new Exception("CPU root executed before matching durable owner");
      Match stamp = Regex.Match(prepared, "\"rootCreated\"\\s*:\\s*\"([0-9]+)\"");
      if (!stamp.Success || stamp.Groups[1].Value != IfcProcessIdentity.Creation(self.Handle)) throw new Exception("CPU root durable native creation identity differs");
      AtomicWrite(Path.Combine(root, "root.started"), self.Id.ToString(CultureInfo.InvariantCulture));
      if (mode == "controller-orphan") {
        ProcessStartInfo info = new ProcessStartInfo(typeof(IfcCpuFixture).Assembly.Location,
          "--fixture-mode=controller-child --fixture-root=\"" + root + "\"");
        info.UseShellExecute = false;
        using (Process child = Process.Start(info)) { if (child == null) throw new Exception("CPU child creation failed"); }
        Thread.Sleep(2000); return 0;
      }
      string portArgument = Argument(args, "--remote-debugging-port=");
      int port = portArgument == null ? 0 : int.Parse(portArgument, CultureInfo.InvariantCulture);
      string journal = Path.Combine(root, "roots.jsonl");
      string record = Identity(self).TrimEnd('}') + ",\"profile\":\"" + Escape(profile) + "\",\"port\":" + port + "}\n";
      AtomicWrite(journal, (File.Exists(journal) ? File.ReadAllText(journal) : "") + record);
      if (mode == "endpoint") {
        TcpListener listener = new TcpListener(IPAddress.Loopback, port); listener.Start();
        try {
          while (true) using (TcpClient client = listener.AcceptTcpClient()) {
            byte[] request = new byte[4096]; client.GetStream().Read(request, 0, request.Length);
            byte[] reply = Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}");
            client.GetStream().Write(reply, 0, reply.Length);
          }
        } finally { listener.Stop(); }
      }
      Thread.Sleep(60000); return 0;
    }
  }
}
