/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;

// #7221: CIM creation dates lose sub-microsecond precision. Native Job identity
// and every observation use this one conversion; no rounded ownership matches.
public static class IfcProcessIdentity {
  [StructLayout(LayoutKind.Sequential)] struct FileTime { public uint Low, High; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out FileTime creation, out FileTime exit, out FileTime kernel, out FileTime user);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr process, uint timeout);
  public sealed class Observation {
    public int pid;
    public string started;
    public string state;
  }
  public static string Creation(IntPtr process) {
    FileTime created, exited, kernel, user;
    if (!GetProcessTimes(process, out created, out exited, out kernel, out user))
      throw new Win32Exception(Marshal.GetLastWin32Error(), "Get exact native creation identity");
    long raw = ((long)created.High << 32) | created.Low;
    return DateTime.FromFileTimeUtc(raw).Ticks.ToString(CultureInfo.InvariantCulture);
  }
  static Observation Inspect(int pid, string expected, int deadlineMs, bool terminate) {
    if (pid <= 0) throw new ArgumentOutOfRangeException("pid");
    if (expected != null) {
      long stamp;
      if (!long.TryParse(expected, NumberStyles.None, CultureInfo.InvariantCulture, out stamp) || stamp <= 0)
        throw new ArgumentException("Missing exact creation identity", "expected");
    }
    if (terminate && (expected == null || deadlineMs <= 0)) throw new ArgumentException("Missing bounded exact retirement policy");
    Process process;
    // Catch only this documented local lookup failure. Opening its handle,
    // access denial, creation query races and waits remain unproved errors.
    try { process = Process.GetProcessById(pid); }
    catch (ArgumentException) { return new Observation { pid = pid, state = "notFound" }; }
    using (process) {
      IntPtr handle = process.Handle; // Retain this resource through kill + wait.
      string started = Creation(handle);
      if (expected != null && started != expected) throw new InvalidOperationException("Exact native process identity mismatch");
      uint waited = WaitForSingleObject(handle, 0);
      if (waited != 0 && waited != 258) throw new Win32Exception(Marshal.GetLastWin32Error(), "Observe exact process exit");
      if (terminate && waited == 258) {
        if (!TerminateProcess(handle, 1)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Terminate exact held process");
        waited = WaitForSingleObject(handle, (uint)deadlineMs);
        if (waited == 258) throw new TimeoutException("Exact held process retirement unproved");
        if (waited != 0) throw new Win32Exception(Marshal.GetLastWin32Error(), "Wait for exact held process retirement");
      }
      return new Observation { pid = pid, started = started, state = waited == 0 ? "exited" : "live" };
    }
  }
  public static Observation Read(int pid) { return Inspect(pid, null, 0, false); }
  public static Observation ObserveExact(int pid, string expected) {
    if (expected == null) throw new ArgumentNullException("expected");
    return Inspect(pid, expected, 0, false);
  }
  public static Observation TerminateExact(int pid, string expected, int deadlineMs) { return Inspect(pid, expected, deadlineMs, true); }
}
