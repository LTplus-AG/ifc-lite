# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

param(
 [Parameter(Mandatory=$true)][string]$Token,
 [Parameter(Mandatory=$true)][string]$Executable,
 [Parameter(Mandatory=$true)][string]$CommandLine,
 [Parameter(Mandatory=$true)][string]$JobModule,
 [Parameter(Mandatory=$true)][string]$InputModule,
 [int]$CleanupMs=15000,
 [int]$DeadlineSeconds=900
)
$ErrorActionPreference='Stop'
if($Token -notmatch '^[a-f0-9]{32}$'){throw 'Invalid exclusively owned job token'}
if($CleanupMs -le 0 -or $CleanupMs -gt 60000 -or $DeadlineSeconds -le 0 -or $DeadlineSeconds -gt 1800){throw 'Invalid job lifecycle deadline'}
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
function Emit($record){[Console]::WriteLine(($record|ConvertTo-Json -Depth 8 -Compress));[Console]::Out.Flush()}
$job=$null;$disposed=$false;$resumed=$false;$failure=$null
$clock=[Diagnostics.Stopwatch]::StartNew()
try {
 Add-Type -Path $JobModule
 Add-Type -Path $InputModule
 $job=[IfcOwnedJob]::new(('Local\ifclite-owned-'+$Token),$Executable,$CommandLine,$null,$CleanupMs)
 $self=[Diagnostics.Process]::GetCurrentProcess()
 try {$supervisorCreated=$self.StartTime.ToUniversalTime().Ticks.ToString()}finally{$self.Dispose()}
 # Root remains suspended until the caller acknowledges durable owner bookkeeping.
 Emit @{event='prepared';jobName=$job.Name;rootPid=$job.RootId;rootCreated=$job.RootCreated;supervisorPid=$PID;supervisorCreated=$supervisorCreated}
 $controlInput=[IfcJobInput]::new()
 while($clock.Elapsed.TotalSeconds -lt $DeadlineSeconds){
  $line=$controlInput.Read(100)
  if($controlInput.Error){throw $controlInput.Error}
  if($null -eq $line){if($controlInput.Ended){throw 'Owned job control pipe closed before disposal proof'};continue}
  $request=ConvertFrom-Json $line
  if($request.id -isnot [long] -and $request.id -isnot [int] -or $request.id -le 0){throw 'Invalid owned job request identity'}
  switch($request.action){
   'resume' {
    if($resumed){throw 'Owned job root already resumed'}
    $job.Resume();$resumed=$true
    Emit @{event='resumed';id=$request.id;jobName=$job.Name}
   }
   'snapshot' {
    $identities=@([IfcOwnedJob]::QueryIdentities($job.Name))
    Emit @{event='snapshot';id=$request.id;jobName=$job.Name;identities=$identities;scope='Kernel-contained CreateProcess descendants; external broker launches not proven'}
   }
   'dispose' {
    $job.TerminateAndWait($CleanupMs);$disposed=$true
    Emit @{event='disposed';id=$request.id;jobName=$job.Name;activeProcesses=0}
    break
   }
   default {throw 'Unknown owned job action'}
  }
  if($disposed){break}
 }
 if(-not $disposed){throw 'Owned job supervisor deadline exceeded'}
}catch {
 $failure=@{error=$_.Exception.ToString();resumed=$resumed}
 $inner=$_.Exception.InnerException
 if($inner){$failure.rootPid=$inner.Data['rootPid'];$failure.rootCreated=$inner.Data['rootCreated'];$failure.jobName=$inner.Data['jobName'];$failure.startupCleanupProved=$inner.Data['startupCleanupProved']}
}finally {
 if($null -ne $job){
  try {if(-not $disposed){$job.TerminateAndWait($CleanupMs)}}
  catch {if($null -eq $failure){$failure=@{error='Owned job cleanup failed'}};$failure.cleanupError=$_.Exception.ToString()}
  finally {
   try {$job.Dispose()}
   catch {if($null -eq $failure){$failure=@{error='Owned job handle close failed'}};$failure.closeError=$_.Exception.ToString()}
  }
 }
 Emit @{event='terminal';ok=($null -eq $failure -and $disposed);disposed=$disposed;failure=$failure}
}
if($null -ne $failure){exit 1}
