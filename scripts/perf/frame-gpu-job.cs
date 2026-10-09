/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// #7036: source-only Windows containment primitive. No native Chrome admission.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public sealed class IfcOwnedJob : IDisposable {
  const uint KillOnClose = 0x2000;
  const uint Suspended = 0x4;
  const uint ProcessQuery = 0x1000;
  const uint JobQuery = 0x4;
  const int AlreadyExists = 183;
  const int MoreData = 234;
  IntPtr job;
  IntPtr root;
  IntPtr thread;
  bool resumed;
  public readonly string Name;
  public readonly uint RootId;
  public readonly string RootCreated;

  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters {
    public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits Basic;
    public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct StartupInfo {
    public uint Size;
    public string Reserved, Desktop, Title;
    public uint X, Y, Width, Height, XCount, YCount, Fill, Flags;
    public ushort Show, ReservedSize;
    public IntPtr ReservedData, Input, Output, Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
    public IntPtr Process, Thread;
    public uint ProcessId, ThreadId;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security, string name);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int info, ref ExtendedLimits limits, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int info, IntPtr result, uint size, out uint returned);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string exe, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string cwd, ref StartupInfo startup, out ProcessInfo process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  static void Require(bool success, string operation) {
    if (!success) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
  }
  // Caller persists profile/token/job/root metadata BEFORE Resume. The root cannot
  // execute before successful assignment. No breakaway or sandbox-disabling flags.
  public IfcOwnedJob(string name, string exe, string commandLine, string cwd, int failureCleanupMs) {
    if (failureCleanupMs <= 0) throw new ArgumentException("Missing failed-start cleanup deadline");
    if (String.IsNullOrWhiteSpace(name) || String.IsNullOrWhiteSpace(exe)) throw new ArgumentException("Missing owned job identity");
    Name = name;
    job = CreateJobObject(IntPtr.Zero, name);
    if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject");
    try {
      if (Marshal.GetLastWin32Error() == AlreadyExists) throw new InvalidOperationException("Refuse existing job name");
      ExtendedLimits limits = new ExtendedLimits();
      limits.Basic.Flags = KillOnClose;
      Require(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))), "Set kill-on-close, no breakaway");
      StartupInfo startup = new StartupInfo(); startup.Size = (uint)Marshal.SizeOf(typeof(StartupInfo));
      ProcessInfo process;
      Require(CreateProcess(exe, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, false, Suspended, IntPtr.Zero, String.IsNullOrWhiteSpace(cwd) ? null : cwd, ref startup, out process), "Create suspended root");
      root = process.Process; thread = process.Thread; RootId = process.ProcessId;
      RootCreated = IfcProcessIdentity.Creation(root);
      Require(AssignProcessToJobObject(job, root), "Assign suspended root");
      bool member;
      Require(IsProcessInJob(root, job, out member), "Verify root containment");
      if (!member) throw new InvalidOperationException("Suspended root not contained");
    } catch (Exception error) {
      Exception cleanup = null;
      // Assignment can fail. Retire the exact newly created suspended root handle;
      // never replace its source error or identity with a cleanup-only exception.
      try {
        if (root != IntPtr.Zero) {
          Require(TerminateProcess(root, 1), "Terminate failed suspended root");
          if (WaitForSingleObject(root, (uint)failureCleanupMs) != 0) throw new TimeoutException("Failed suspended root termination unproved");
        }
      } catch (Exception failure) { cleanup = failure; }
      finally {
        try { Dispose(); }
        catch (Exception failure) { cleanup = cleanup == null ? failure : new AggregateException(cleanup, failure); }
      }
      Exception reported = cleanup == null ? error : new AggregateException("Owned job startup and cleanup failed", error, cleanup);
      reported.Data["jobName"] = Name;
      reported.Data["rootPid"] = RootId;
      reported.Data["rootCreated"] = RootCreated;
      reported.Data["startupCleanupProved"] = cleanup == null;
      throw reported;
    }
  }
  public void Resume() {
    if (resumed || thread == IntPtr.Zero) throw new InvalidOperationException("Root already resumed or closed");
    // A changed suspension count may already permit execution. Any error here
    // requires caller job cleanup; it is never a never-executed receipt.
    uint prior = ResumeThread(thread);
    if (prior == UInt32.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error(), "Resume contained root");
    if (prior != 1) throw new InvalidOperationException("Owned root suspension state changed; refuse execution proof");
    resumed = true;
    Release(ref thread);
  }
  static uint[] ProcessIds(IntPtr handle) {
    for (int capacity = 16; capacity <= 65536; capacity *= 2) {
      int size = checked(8 + capacity * IntPtr.Size);
      IntPtr buffer = Marshal.AllocHGlobal(size);
      try {
        uint returned;
        if (!QueryInformationJobObject(handle, 3, buffer, (uint)size, out returned)) {
          int error = Marshal.GetLastWin32Error();
          if (error == MoreData) continue;
          throw new Win32Exception(error, "Query active job processes");
        }
        int assigned = Marshal.ReadInt32(buffer, 0), count = Marshal.ReadInt32(buffer, 4);
        if (assigned < 0 || count < 0 || count > capacity || assigned != count) throw new InvalidOperationException("Incomplete active job process query");
        uint[] ids = new uint[count];
        for (int i = 0; i < count; i++) {
          long value = Marshal.ReadIntPtr(buffer, 8 + i * IntPtr.Size).ToInt64();
          if (value <= 0 || value > UInt32.MaxValue) throw new InvalidOperationException("Invalid active job PID");
          ids[i] = (uint)value;
        }
        return ids;
      } finally { Marshal.FreeHGlobal(buffer); }
    }
    throw new InvalidOperationException("Active job query exceeds bounded buffer; ownership unresolved");
  }
  public uint[] ActiveIds() {
    if (job == IntPtr.Zero) throw new ObjectDisposedException("Owned job");
    return ProcessIds(job);
  }
  public static uint[] QueryNamed(string name) {
    IntPtr handle = OpenJobObject(JobQuery, false, name);
    if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Open owned job for observation");
    try { return ProcessIds(handle); } finally { Require(CloseHandle(handle), "Close job observation handle"); }
  }
  public sealed class Identity {
    public uint pid;
    public string started;
  }
  public static Identity[] QueryIdentities(string name) {
    IntPtr handle = OpenJobObject(JobQuery, false, name);
    if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Open owned job identity observation");
    try {
      List<Identity> identities = new List<Identity>();
      foreach (uint id in ProcessIds(handle)) {
        IntPtr process = OpenProcess(ProcessQuery, false, id);
        if (process == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Active job PID observation raced or unavailable");
        try {
          bool member; Require(IsProcessInJob(process, handle, out member), "Verify active job PID ownership");
          if (!member) throw new InvalidOperationException("Active job PID reused or departed");
          identities.Add(new Identity { pid = id, started = IfcProcessIdentity.Creation(process) });
        } finally { Require(CloseHandle(process), "Close process observation handle"); }
      }
      return identities.ToArray();
    } finally { Require(CloseHandle(handle), "Close job observation handle"); }
  }
  public void TerminateAndWait(int deadlineMs) {
    if (deadlineMs <= 0) throw new ArgumentException("Missing cleanup deadline");
    if (job == IntPtr.Zero) throw new ObjectDisposedException("Owned job");
    Require(TerminateJobObject(job, 1), "Terminate exclusively owned job");
    Stopwatch elapsed = Stopwatch.StartNew();
    do {
      if (ActiveIds().Length == 0) return;
      Thread.Sleep(Math.Min(50, deadlineMs));
    } while (elapsed.ElapsedMilliseconds < deadlineMs);
    throw new TimeoutException("Owned job active-zero proof missing; retain profile and receipt");
  }
  static void Release(ref IntPtr handle) {
    if (handle == IntPtr.Zero) return;
    Require(CloseHandle(handle), "Close exclusively owned handle");
    handle = IntPtr.Zero;
  }
  public void Dispose() {
    try { Release(ref thread); }
    finally { try { Release(ref root); } finally { Release(ref job); } }
  }
}
