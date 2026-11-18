#requires -Version 7.2
[CmdletBinding()]
param(
 [ValidateSet('Install','Verify','Uninstall','Diagnose','Recover','Prerequisites')][string]$Action='Install',
 [string]$SkillStore=(Join-Path $HOME '.scout\m-skills'),
 [string]$OutputRoot,
 [switch]$Confirm,
 [switch]$TrustDownloadedPayload,
 [switch]$PrerequisitesConfirmed
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if($Action -eq 'Prerequisites'){
 $guide=Join-Path $PSScriptRoot 'PREREQUISITES.html';if(-not [IO.File]::Exists($guide)){$guide=Join-Path (Split-Path -Parent $PSScriptRoot) 'PREREQUISITES.html'}
 if(-not [IO.File]::Exists($guide)){throw 'PREREQUISITES.html is missing. Extract the complete trusted release and open its guide.'}
 Start-Process -FilePath $guide
 @{ok=$true;opened='PREREQUISITES.html';sourceRequests=$false}|ConvertTo-Json -Compress
 exit 0
}
function FullPath([string]$Value){if(-not [IO.Path]::IsPathFullyQualified($Value)){throw 'Installation paths must be absolute.'};return [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath($Value))}
function IsWithin([string]$Parent,[string]$Child){return $Child.Equals($Parent,[StringComparison]::OrdinalIgnoreCase) -or $Child.StartsWith($Parent.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)}
function PhysicalPath([string]$Value){
 $absolute=FullPath $Value;$parent=Split-Path -Parent $absolute
 if(-not $parent){return $absolute}
 $candidate=Join-Path (PhysicalPath $parent) (Split-Path -Leaf $absolute)
 if(Test-Path -LiteralPath $candidate){$item=Get-Item -LiteralPath $candidate -Force;if($item.LinkType){return FullPath $item.ResolveLinkTarget($true).FullName}}
 return $candidate
}
function Assert-PlainTree([string]$Root){
 $pending=[Collections.Generic.Queue[string]]::new();$pending.Enqueue($Root)
 while($pending.Count){$item=Get-Item -LiteralPath $pending.Dequeue() -Force;if($item.LinkType){throw "A managed file or folder is a link: $($item.FullName)"};if($item.PSIsContainer){foreach($child in Get-ChildItem -LiteralPath $item.FullName -Force){$pending.Enqueue($child.FullName)}}}
}
function Read-Receipt([string]$Root){
 $file=Join-Path $Root '.sn-demoseeder-install.json'
 if(-not [IO.File]::Exists($file)){throw 'An existing skill without an installation receipt will not be overwritten. Keep authored source intact; choose a separate installation location for a trial.'}
 $value=Get-Content -LiteralPath $file -Raw|ConvertFrom-Json
 if($value.schemaVersion -ne 1 -or $value.product -ne 'sn-demoseeder' -or -not $value.files.Count){throw 'Installed ownership receipt is invalid.'}
 return $value
}
function Assert-Files([string]$Root,$Files,[string[]]$Extra=@()){
 Assert-PlainTree $Root
 $expected=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
 $directories=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
 foreach($file in $Files){
  if($file.path -notmatch '^[A-Za-z0-9_.-]+(\\[A-Za-z0-9_.-]+)*$' -or @($file.path.Split('\')|Where-Object {$_ -in @('.','..')}).Count -or $file.sha256 -notmatch '^[0-9a-f]{64}$' -or -not $expected.Add($file.path)){throw 'Package manifest contains an invalid or duplicate managed path.'}
  $absolute=Join-Path $Root $file.path
  $parent=Split-Path -Parent $file.path;while($parent){$null=$directories.Add($parent);$parent=Split-Path -Parent $parent}
  if(-not [IO.File]::Exists($absolute) -or (Get-FileHash -LiteralPath $absolute -Algorithm SHA256).Hash -ine $file.sha256){throw "Managed file is missing or changed: $($file.path). No installation was replaced."}
 }
 foreach($name in $Extra){$null=$expected.Add($name)}
 foreach($file in Get-ChildItem -LiteralPath $Root -File -Recurse -Force){$relative=[IO.Path]::GetRelativePath($Root,$file.FullName);if(-not $expected.Contains($relative)){throw "Unmanaged file would be lost: $relative. Preserve it outside the skill before updating."}}
 foreach($directory in Get-ChildItem -LiteralPath $Root -Directory -Recurse -Force){$relative=[IO.Path]::GetRelativePath($Root,$directory.FullName);if(-not $directories.Contains($relative)){throw "Unmanaged directory would be lost: $relative. Preserve it outside the skill before updating."}}
}
function Field($Value,[string]$Name){if($null -eq $Value){return $null};$property=$Value.PSObject.Properties[$Name];if($property){return $property.Value};return $null}
function Process-Evidence([int]$ProcessId){
 try{$process=[Diagnostics.Process]::GetProcessById($ProcessId)}catch [ArgumentException]{return $null}
 try{return @{pid=$process.Id;startedAt=$process.StartTime.ToUniversalTime().ToString('o');executablePath=$process.MainModule.FileName}}finally{$process.Dispose()}
}
function Owner-State($Record,[switch]$Service){
 $id=Field $Record 'pid';if($id -isnot [int] -and $id -isnot [long]){return 'unknown'}
 $identity=Process-Evidence $id;if(-not $identity){return 'stale'}
 $exact=Field $Record 'processStartedAt';$saved=if($exact){$exact}else{Field $Record 'startedAt'}
 if(-not $saved){return 'unknown'}
 $created=[DateTimeOffset]::Parse($identity.startedAt);$recorded=if($saved -is [DateTime] -or $saved -is [DateTimeOffset]){[DateTimeOffset]$saved}else{[DateTimeOffset]::Parse([string]$saved)}
 if($exact){if($created -ne $recorded){return 'stale'};if((FullPath $identity.executablePath) -ine (FullPath (Field $Record 'executablePath'))){return 'unknown'};return 'live'}
 if($created -gt $recorded.AddSeconds(2)){return 'stale'}
 if($created -lt $recorded.AddMinutes(-2)){return 'unknown'}
 if($Service -and [IO.Path]::GetFileName($identity.executablePath) -ine 'node.exe'){return 'unknown'}
 return 'live'
}
function Read-OptionalJson([string]$File){if(-not [IO.File]::Exists($File)){return $null};return Get-Content -LiteralPath $File -Raw|ConvertFrom-Json}
function Download-Marked([string]$File){
 try{$zone=[IO.File]::ReadAllText($File+':Zone.Identifier')}catch [IO.FileNotFoundException]{return $false}catch [IO.DirectoryNotFoundException]{return $false}
 return $zone -match '(?m)^ZoneId\s*=\s*[34]\s*$'
}
function Assert-Idle([string]$Runtime){
 $state=Join-Path $Runtime 'state'
 if([IO.File]::Exists((Join-Path $state 'registry.lock'))){throw 'The local registry is locked. Finish/reconcile the existing operation before installing.'}
 $locks=Join-Path $state 'pdi-locks'
 if([IO.Directory]::Exists($locks) -and @(Get-ChildItem -LiteralPath $locks -File -Force).Count){throw 'A PDI execution lock exists. Do not remove it automatically; inspect/reconcile its owner first.'}
 $startup=Join-Path $state 'config-server.json'
 if([IO.File]::Exists($startup)){$owner=Read-OptionalJson $startup;if((Owner-State $owner -Service) -ne 'stale'){throw 'A Config Builder is running or its ownership is unverified. Use StopConfig -Confirm, or Diagnose for exact owner evidence, before installing.'}}
}
function Lease-State([string]$File){
 if(-not [IO.File]::Exists($File)){return 'absent'}
 try{$probe=[IO.File]::Open($File,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);$probe.Dispose();return 'abandoned'}catch [IO.FileNotFoundException]{return 'absent'}catch [IO.IOException]{if(($_.Exception.HResult -band 65535) -in @(32,33)){return 'active'};throw}
}
function Recovery-Stages([string]$Store){
 if(-not [IO.Directory]::Exists($Store)){return}
 foreach($directory in Get-ChildItem -LiteralPath $Store -Directory -Force){if($directory.Name -match '^\.sn-(install|remove)-[0-9a-f]{32}$'){@{path=$directory.FullName;hasPrevious=[IO.Directory]::Exists((Join-Path $directory.FullName 'previous'));hasPayload=[IO.Directory]::Exists((Join-Path $directory.FullName 'payload'))}}}
}
function Diagnosis([string]$Runtime,[string]$Store){
 $state=Join-Path $Runtime 'state';$startup=Read-OptionalJson (Join-Path $state 'config-server.json');$registry=Read-OptionalJson (Join-Path $state 'registry.lock')
 $serviceState=if($startup){Owner-State $startup -Service}else{'absent'};$registryState=if($registry){Owner-State $registry}else{'absent'}
 $pdiDirectory=Join-Path $state 'pdi-locks';$pdiCount=if([IO.Directory]::Exists($pdiDirectory)){@(Get-ChildItem -LiteralPath $pdiDirectory -File -Force).Count}else{0}
 return @{ok=$true;service=@{state=$serviceState;pid=(Field $startup 'pid')};registry=@{state=$registryState;pid=(Field $registry 'pid')};installationLease=(Lease-State (Join-Path $state 'installation.lock'));stages=@(Recovery-Stages $Store);pdiLocksPreserved=$pdiCount;processStopped=$false;sourceChanges=$false}
}
function Recover-Local([string]$Runtime,[string]$Store,[string]$Target,[string]$Output){
 $before=Diagnosis $Runtime $Store
 if($before.installationLease -eq 'active'){throw 'The installer lease is actively held. Wait for its exact owner; no recovery or process termination was attempted.'}
 if($before.service.state -in @('live','unknown')){throw 'Config Builder ownership is live or unverified. Run StopConfig -Confirm first; recovery never kills a process.'}
 if($before.registry.state -in @('live','unknown')){throw 'The registry owner is live or unverified. No registry/PDI lock was removed.'}
 if($before.stages.Count -and $before.pdiLocksPreserved){throw 'Resource recovery is blocked by a PDI operation. Preserve its journal and reconcile the exact source operation; no PDI lock was removed.'}
 $state=Join-Path $Runtime 'state';$null=[IO.Directory]::CreateDirectory($state);$file=Join-Path $state 'installation.lock';$hadLease=[IO.File]::Exists($file);$handle=$null;$complete=$false
 $changes=[Collections.Generic.List[string]]::new()
 try{
  $mode=if($hadLease){[IO.FileMode]::Open}else{[IO.FileMode]::CreateNew};$handle=[IO.File]::Open($file,$mode,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  if($handle.Length -gt 65536){throw 'Installer lease metadata exceeds its supported size; no recovery was attempted.'}
  $memory=[IO.MemoryStream]::new();$handle.CopyTo($memory);$original=$memory.ToArray();$memory.Dispose()
  $saved=$null;if($original.Length){try{$saved=[Text.Encoding]::UTF8.GetString($original)|ConvertFrom-Json}catch [ArgumentException]{throw 'Installer lease metadata is invalid.'}catch [System.Management.Automation.RuntimeException]{$saved=$null}}
  $savedTarget=Field $saved 'targetSkillRoot';$renameTargets=@((PhysicalPath (Join-Path $Store 'sn-demoseeder')),(PhysicalPath (Join-Path $Store 'sn-demoloader')))
  if($savedTarget -and (PhysicalPath $savedTarget) -ine (PhysicalPath $Target) -and -not ((PhysicalPath $savedTarget) -iin $renameTargets -and (PhysicalPath $Target) -iin $renameTargets)){throw 'The abandoned lease belongs to a different skill store. Use its recorded target; no resources were moved.'}
  $savedOutput=Field $saved 'outputRoot';if($savedOutput -and (PhysicalPath $savedOutput) -ine (PhysicalPath $Output)){throw 'The abandoned lease belongs to another output library. No data or resources were moved.'}
  $stages=@(Recovery-Stages $Store);$previous=@()
  foreach($stage in $stages){Assert-PlainTree $stage.path;if($stage.hasPrevious){$old=Join-Path $stage.path 'previous';$receipt=Read-Receipt $old;Assert-Files $old $receipt.files @('.sn-demoseeder-install.json');if((PhysicalPath $receipt.outputRoot) -ine (PhysicalPath $Output)){throw 'A recovery backup belongs to a different output library.'};$previous+=,$old}}
  $targetPresent=[IO.Directory]::Exists($Target)
  if(-not $targetPresent -and $previous.Count -gt 1){throw 'Multiple verified previous installations exist. Diagnose lists their locations; no backup was guessed or overwritten.'}
  if($targetPresent -and [IO.File]::Exists((Join-Path $Target '.sn-demoseeder-install.json'))){$current=Read-Receipt $Target;Assert-Files $Target $current.files @('.sn-demoseeder-install.json')}
  $again=Diagnosis $Runtime $Store
  if($again.service.state -in @('live','unknown') -or $again.registry.state -in @('live','unknown')){throw 'A local owner changed during recovery. No resources were moved.'}
  $recovery=Join-Path $state 'recovery';$null=[IO.Directory]::CreateDirectory($recovery);$id=[guid]::NewGuid().ToString('N')
  if(-not $targetPresent -and $previous.Count -eq 1){[IO.Directory]::Move($previous[0],$Target);$changes.Add('Restored the verified previous skill installation.')}
  foreach($stage in $stages){$archive=Join-Path $Store ('.sn-recovered-'+[guid]::NewGuid().ToString('N'));[IO.Directory]::Move($stage.path,$archive);$changes.Add('Preserved interrupted staging in '+$archive)}
  foreach($entry in @(@{name='config-server.json';state=$again.service.state},@{name='registry.lock';state=$again.registry.state})){
   if($entry.state -eq 'stale'){$source=Join-Path $state $entry.name;[IO.File]::Move($source,(Join-Path $recovery ($id+'-'+$entry.name)));$changes.Add('Archived stale '+$entry.name+'; no process was stopped.')}
  }
  if($hadLease){[IO.File]::WriteAllBytes((Join-Path $recovery ($id+'-installation-lock.json')),$original);$changes.Add('Archived the abandoned installer lease after acquiring it exclusively.')}
  $report=@{ok=$true;action='Recover';changes=@($changes);pdiLocksPreserved=$again.pdiLocksPreserved;outputRoot=$Output;credentialsPreserved=$true;processStopped=$false;sourceChanges=$false;next='Run Install again if needed, then Configure. PDI execution locks/journals were not reset.'}
  [IO.File]::WriteAllText((Join-Path $recovery ($id+'-result.json')),($report|ConvertTo-Json -Depth 6));$complete=$true;return $report
 }finally{if($handle){$handle.Dispose();if($complete){[IO.File]::Delete($file)}else{Write-Warning 'Recovery did not complete; the installer lease and recovery evidence were retained. Run Diagnose before retrying.'}}}
}
$SkillStore=FullPath $SkillStore
$target=Join-Path $SkillStore 'sn-demoloader'
$legacyTarget=Join-Path $SkillStore 'sn-demoseeder'
$runtime=FullPath (Join-Path $env:LOCALAPPDATA 'Scout\ServiceNowDemoSeeder')
$inspection=$Action -in @('Diagnose','Recover')
if(-not $inspection -and (IsWithin (FullPath (Join-Path $HOME '.copilot\skills')) $target)){throw 'Install once in the Scout local skill store, not in the global Copilot skills store.'}
foreach($name in @('sn-demoloader','sn-demoseeder')){if(-not $inspection -and [IO.Directory]::Exists((Join-Path $HOME ('.copilot\skills\'+$name)))){throw ('A global '+$name+' registration already exists. Resolve the duplicate explicitly before installing a local copy.')}}
if([IO.Directory]::Exists($target) -and [IO.Directory]::Exists($legacyTarget)){throw 'Both sn-demoloader and legacy sn-demoseeder exist. Resolve the duplicate registration explicitly; neither was modified.'}
$existingRoot=if([IO.Directory]::Exists($target)){$target}elseif([IO.Directory]::Exists($legacyTarget)){$legacyTarget}else{$null}
if($Action -ne 'Install' -and $existingRoot){$target=$existingRoot}
$existing=$null
if($existingRoot){if(-not $inspection -or [IO.File]::Exists((Join-Path $existingRoot '.sn-demoseeder-install.json'))){$existing=Read-Receipt $existingRoot}}
if(-not $OutputRoot){
 if($existing){$OutputRoot=$existing.outputRoot}
 else{
  $freshOutput=Join-Path $HOME '.copilot\SN-DemoLoader-Output-Scout';$legacyOutput=Join-Path $HOME '.copilot\SN-DemoSeed-Output-Scout'
  if([IO.Directory]::Exists($freshOutput) -and [IO.Directory]::Exists($legacyOutput) -and (PhysicalPath $freshOutput) -ine (PhysicalPath $legacyOutput)){throw 'Both current and legacy output libraries exist. Pass the explicitly reviewed -OutputRoot; no library was guessed or moved.'}
  $OutputRoot=if([IO.Directory]::Exists($legacyOutput)){$legacyOutput}else{$freshOutput}
 }
}
$OutputRoot=FullPath $OutputRoot
foreach($root in @($SkillStore,$runtime)){if((IsWithin $root $OutputRoot) -or (IsWithin $OutputRoot $root)){throw 'Output, skill resources and protected runtime must be separate trees.'}}
foreach($root in @($SkillStore,$runtime)){$physicalRoot=PhysicalPath $root;$physicalOutput=PhysicalPath $OutputRoot;if((IsWithin $physicalRoot $physicalOutput) -or (IsWithin $physicalOutput $physicalRoot)){throw 'Output, skill resources and protected runtime must be separate trees, including through directory links.'}}
if((IsWithin (PhysicalPath $runtime) (PhysicalPath $SkillStore)) -or (IsWithin (PhysicalPath $SkillStore) (PhysicalPath $runtime))){throw 'Skill resources cannot overlap protected runtime.'}
if($existing -and (FullPath $existing.outputRoot) -ine $OutputRoot){throw 'An update cannot switch output libraries. Migrate the library separately after stopping all local operations.'}
if($Action -eq 'Diagnose'){Diagnosis $runtime $SkillStore|ConvertTo-Json -Depth 6 -Compress;exit 0}
if($Action -eq 'Recover'){if(-not $Confirm){throw 'Recover requires -Confirm after reviewing Diagnose. It never removes PDI execution locks or terminates a process.'};Recover-Local $runtime $SkillStore $target $OutputRoot|ConvertTo-Json -Depth 6 -Compress;exit 0}
if($Action -eq 'Verify'){
 if(-not $existing){throw 'SN DemoLoader is not installed at this skill store.'}
 Assert-Files $target $existing.files @('.sn-demoseeder-install.json')
 @{ok=$true;action=$Action;version=$existing.version;skillRoot=$target;outputRoot=$OutputRoot;runtimeHome=$runtime}|ConvertTo-Json -Compress
 exit 0
}
if(-not $IsWindows){throw 'This release supports Windows only.'}
if(-not $Confirm){throw "$Action requires -Confirm. No files have been changed."}
if([IO.File]::Exists((Join-Path $runtime 'state\installation.lock'))){throw 'An installer lease exists. Run Install.cmd Diagnose, then Install.cmd Recover only for an abandoned lease. No resources were changed.'}
Assert-Idle $runtime
if($existing){Assert-Files $existingRoot $existing.files @('.sn-demoseeder-install.json')}
$packageRoot=$PSScriptRoot
$manifest=$null
if($Action -eq 'Install'){
 $manifest=Get-Content -LiteralPath (Join-Path $packageRoot 'package-manifest.json') -Raw|ConvertFrom-Json
 if($manifest.schemaVersion -ne 1 -or $manifest.product -ne 'sn-demoseeder' -or $manifest.version -notmatch '^\d+\.\d+\.\d+$'){throw 'Release manifest is invalid.'}
 $payload=Join-Path $packageRoot 'skill'
 Assert-Files $payload $manifest.files
 $packagedRelease=Get-Content -LiteralPath (Join-Path $payload 'app\release.json') -Raw|ConvertFrom-Json
 if($packagedRelease.product -ne $manifest.product -or $packagedRelease.version -ne $manifest.version){throw 'Runtime and manifest release metadata do not agree.'}
 if($manifest.skillName -cne 'sn-demoloader' -or $packagedRelease.skillName -cne 'sn-demoloader' -or $packagedRelease.displayName -cne 'SN DemoLoader'){throw 'This installer requires the SN DemoLoader release payload.'}
 foreach($required in @('SKILL.md','scripts\launch.ps1','app\install-layout.json','app\release.json','app\PREREQUISITES.html','app\prerequisites.json','app\scripts\cli.cjs','app\scripts\manage.ps1','app\lib\profiles.cjs')){if($required -notin @($manifest.files.path)){throw "Required managed resource is missing: $required"}}
 $prerequisites=Get-Content -LiteralPath (Join-Path $payload 'app\prerequisites.json') -Raw|ConvertFrom-Json
 if($prerequisites.schemaVersion -ne 1 -or $prerequisites.id -ne 'pdi-machine-v1' -or $prerequisites.machineUserName -cne 'demo.seeder' -or ($prerequisites.requiredSetupRoles -join ',') -cne 'admin,itil_admin,knowledge_admin,user_admin' -or $prerequisites.acknowledgementIsVerification -ne $false){throw 'Prerequisite metadata is invalid. Obtain a complete supported release.'}
 if(-not $PrerequisitesConfirmed){throw 'Before installing: open PREREQUISITES.html. Prepare an awake owned non-production PDI and an active demo.seeder Machine account with Web service access only, its private password, no lockout/reset, and admin, itil_admin, knowledge_admin, user_admin roles. Use Install.cmd and its READY acknowledgement, or explicitly add -PrerequisitesConfirmed once prepared. This acknowledges your setup; it does not verify remote access. No source requests or installation changes were made.'}
 if('.sn-demoseeder-install.json' -in @($manifest.files.path)){throw 'An installation receipt cannot be supplied by the release payload.'}
 if($existing -and [version]$manifest.version -lt [version]$existing.version){throw 'Release downgrade is not supported. Use an explicitly reviewed recovery instead.'}
 $node=Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue
 if(-not $node){throw 'Node.js 22 or newer was not found on PATH. Install it from https://nodejs.org and reopen the installer.'}
 $nodeVersion=& $node.Source --version
 if($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22){throw 'Install Node.js 22 or newer and reopen PowerShell.'}
 $edge=@(@(${env:ProgramFiles(x86)},$env:ProgramFiles,$env:LOCALAPPDATA)|Where-Object {$_}|ForEach-Object {Join-Path $_ 'Microsoft\Edge\Application\msedge.exe'}|Where-Object {[IO.File]::Exists($_)}|Select-Object -First 1)
 if(-not $edge.Count){throw 'Microsoft Edge was not found in Program Files (x86), Program Files or local application data. Install Edge, then rerun the installer.'}
 $marked=@($manifest.files|Where-Object {$_.path.EndsWith('.ps1',[StringComparison]::OrdinalIgnoreCase) -and (Download-Marked (Join-Path $payload $_.path))})
 if($marked.Count -and -not $TrustDownloadedPayload){throw 'Downloaded payload scripts are blocked by Windows. Use Install.cmd from a trusted release to review and approve unblocking these exact scripts; do not bypass execution policy.'}
 if($TrustDownloadedPayload){foreach($file in $marked){Unblock-File -LiteralPath (Join-Path $payload $file.path)}}
}
$null=[IO.Directory]::CreateDirectory($SkillStore)
$installState=Join-Path $runtime 'state'
$null=[IO.Directory]::CreateDirectory($installState)
$installLock=Join-Path $installState 'installation.lock'
$lease=$null;$backup=$null;$committed=$false
$prefix=if($Action -eq 'Uninstall'){'.sn-remove-'}else{'.sn-install-'}
$stage=Join-Path $SkillStore ($prefix+[guid]::NewGuid().ToString('N'))
try{
 $lease=[IO.File]::Open($installLock,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 $owner=Process-Evidence $PID
 $bytes=[Text.Encoding]::UTF8.GetBytes((@{schemaVersion=2;pid=$PID;processStartedAt=$owner.startedAt;executablePath=$owner.executablePath;action=$Action;startedAt=[DateTime]::UtcNow.ToString('o');targetSkillRoot=$target;previousSkillRoot=$existingRoot;outputRoot=$OutputRoot;stageRoot=$stage}|ConvertTo-Json -Compress));$lease.Write($bytes,0,$bytes.Length);$lease.Flush($true)
 Assert-Idle $runtime
 if($Action -eq 'Uninstall'){
  if(-not $existing){throw 'No managed SN DemoLoader installation exists here.'}
  Assert-Files $target $existing.files @('.sn-demoseeder-install.json')
  $null=[IO.Directory]::CreateDirectory($stage)
  $backup=Join-Path $stage 'previous'
  [IO.Directory]::Move($target,$backup)
  $committed=$true
  Remove-Item -LiteralPath $backup -Recurse -Force
  @{ok=$true;action=$Action;removedSkillRoot=$target;preservedOutputRoot=$OutputRoot;preservedRuntimeHome=$runtime;sourceChanges=$false}|ConvertTo-Json -Compress
  return
 }
 $stagedPayload=Join-Path $stage 'payload'
 $null=[IO.Directory]::CreateDirectory($stagedPayload)
 foreach($file in $manifest.files){$dest=Join-Path $stagedPayload $file.path;$null=[IO.Directory]::CreateDirectory((Split-Path -Parent $dest));[IO.File]::Copy((Join-Path $payload $file.path),$dest,$false)}
 Assert-Files $stagedPayload $manifest.files
 $acknowledgement=@{id=$prerequisites.id;acknowledgedAt=[DateTime]::UtcNow.ToString('o');source='operator-acknowledgement-only';verified=$false;requiredSetupRoles=@($prerequisites.requiredSetupRoles)}
 $receipt=@{schemaVersion=1;product='sn-demoseeder';displayName='SN DemoLoader';skillName='sn-demoloader';version=$manifest.version;outputRoot=$OutputRoot;installedAt=[DateTime]::UtcNow.ToString('o');files=@($manifest.files);prerequisites=$acknowledgement}
 [IO.File]::WriteAllText((Join-Path $stagedPayload '.sn-demoseeder-install.json'),($receipt|ConvertTo-Json -Depth 8))
 foreach($name in @('configs','runs','logs')){$null=[IO.Directory]::CreateDirectory((Join-Path $OutputRoot $name))}
 if([IO.Directory]::Exists($target) -and $target -ine $existingRoot){throw 'The target appeared during installation. It will not be overwritten.'}
 if($existingRoot){
  Assert-Files $existingRoot $existing.files @('.sn-demoseeder-install.json')
  $backup=Join-Path $stage 'previous'
  [IO.Directory]::Move($existingRoot,$backup)
 }
 try{[IO.Directory]::Move($stagedPayload,$target)}catch{if($backup -and [IO.Directory]::Exists($backup) -and -not [IO.Directory]::Exists($existingRoot)){[IO.Directory]::Move($backup,$existingRoot)};throw}
 $committed=$true
 @{ok=$true;action=if($existingRoot -and $existingRoot -ine $target){'RenameUpgrade'}elseif($existing){'Update'}else{'Install'};version=$manifest.version;displayName='SN DemoLoader';skillName='sn-demoloader';skillRoot=$target;outputRoot=$OutputRoot;runtimeHome=$runtime;prerequisites=@{acknowledged=$true;verified=$false;guide=(Join-Path $target 'app\PREREQUISITES.html')};next='Restart Scout, run /sn-demoloader, choose Configure, then Use existing account / Existing Machine account. Save the Machine password under Access and Test read access.';sourceChanges=$false}|ConvertTo-Json -Depth 4 -Compress
}finally{
 if($stage -and [IO.Directory]::Exists($stage)){
  if($committed -or -not ($backup -and [IO.Directory]::Exists($backup))){Remove-Item -LiteralPath $stage -Recurse -Force}else{Write-Warning "Installation backup retained for recovery: $backup"}
 }
 if($lease){$lease.Dispose();[IO.File]::Delete($installLock)}
}
