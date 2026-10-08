# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

# One exact Windows argument policy for launcher cleanup and resident sampling (#7036).
if(-not ('IfcChromeArgs' -as [type])) {
 Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class IfcChromeArgs {
  [DllImport("shell32.dll", SetLastError=true)] static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string line, out int count);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
  public static string[] Split(string line) {
    int count; IntPtr result=CommandLineToArgvW(line,out count);
    if(result==IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    try { string[] values=new string[count]; for(int i=0;i<count;i++) values[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(result,i*IntPtr.Size)); return values; }
    finally { LocalFree(result); }
  }
}
'@
}
function Get-OwnedChromeProcesses {
 param([Parameter(Mandatory=$true)][string]$Profile,[object[]]$Processes=@(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'"),[switch]$BrowserRoot,[switch]$RequireCompleteObservation)
 if($RequireCompleteObservation) {
  $identities=@{}
  foreach($process in $Processes) {
   if($null -eq $process -or [string]::IsNullOrWhiteSpace($process.CommandLine)){throw 'Chrome command-line observation incomplete; allocated profile ownership remains unresolved'}
   if($process.ProcessId -isnot [int] -and $process.ProcessId -isnot [long] -and $process.ProcessId -isnot [uint32] -and $process.ProcessId -isnot [uint64]){throw 'Chrome PID observation incomplete'}
   if($process.ProcessId -le 0 -or $process.CreationDate -isnot [datetime] -or $process.CreationDate.Ticks -le 0){throw 'Chrome creation identity observation incomplete'}
   if($identities.ContainsKey($process.ProcessId)){throw 'Duplicate Chrome PID observation'}
   $identities[$process.ProcessId]=$true
  }
 }
 return @($Processes | Where-Object {
  if(-not $_.CommandLine){return $false}
  $arguments=[IfcChromeArgs]::Split($_.CommandLine)
  ($arguments -contains ('--user-data-dir='+$Profile)) -and (-not $BrowserRoot -or @($arguments | Where-Object {$_.StartsWith('--type=')}).Count -eq 0)
 })
}
