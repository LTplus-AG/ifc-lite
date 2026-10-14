# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

# Read-only owned-window output configuration; not a powered-panel oracle.
# DEVMODEW ABI: https://learn.microsoft.com/windows/win32/api/wingdi/ns-wingdi-devmodew
Add-Type -AssemblyName System.Windows.Forms
if (-not ('IfcFrameWindow' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class IfcFrameWindow {
  [StructLayout(LayoutKind.Explicit, Size=220)] public struct DisplayMode {
    [FieldOffset(68)] public ushort size;
    [FieldOffset(72)] public uint fields;
    [FieldOffset(84)] public uint orientation;
    [FieldOffset(168)] public uint bits;
    [FieldOffset(172)] public uint width;
    [FieldOffset(176)] public uint height;
    [FieldOffset(184)] public uint frequency;
  }
  [DllImport("user32.dll", SetLastError=true)] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr window);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, ExactSpelling=true)] static extern bool EnumDisplaySettingsW(string device, int mode, ref DisplayMode value);
  public static DisplayMode Read(IntPtr window, uint expectedPid, string device) {
    uint pid;
    if (window == IntPtr.Zero || GetWindowThreadProcessId(window, out pid) == 0 || pid != expectedPid)
      throw new InvalidOperationException("Owned Chrome window identity missing or changed");
    DisplayMode value = new DisplayMode(); value.size = (ushort)Marshal.SizeOf(typeof(DisplayMode));
    if (!EnumDisplaySettingsW(device, -1, ref value)) throw new InvalidOperationException("Display settings unavailable");
    // Fields must be reported; zero-filled unsupported fields are not facts.
    const uint required = 0x40000 | 0x80000 | 0x100000 | 0x400000 | 0x80;
    if ((value.fields & required) != required) throw new InvalidOperationException("Required display settings missing");
    return value;
  }
}
'@
}
