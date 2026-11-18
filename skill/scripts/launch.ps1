#requires -Version 7.2
param(
  [ValidateSet('Menu','Paths','Doctor','Prerequisites','Diagnose','Recover','Profiles','Select','History','Configure','StopConfig','PackPreview','PackStatus','PackApprove','PackApply','PackReconcile','MachinePreview','MachineStatus','MachineApprove','MachineApply','MachineReconcile','PeoplePreview','PeopleStatus','PeopleApprove','PeopleApply','PeopleReconcile','ContentPreview','ContentStatus','ContentApprove','ContentApply','ContentReconcile','KnowledgePreview','KnowledgeStatus','KnowledgeApprove','KnowledgeApply','KnowledgeReconcile')][string]$Action='Menu',
  [string]$Name,
  [string]$PersonId,
  [switch]$OpenBrowser,
  [string[]]$Roles=@(),
  [string]$PlanId,
  [string]$PlanHash,
  [string]$InputFile,
  [string]$RecordId,
  [switch]$Confirm
)
$ErrorActionPreference='Stop'
$skillRoot=Split-Path -Parent $PSScriptRoot
$storeDirectory=Get-Item -LiteralPath (Split-Path -Parent $skillRoot)
if($storeDirectory.LinkType){$skillRoot=Join-Path $storeDirectory.ResolveLinkTarget($true).FullName (Split-Path -Leaf $skillRoot)}
$scoutRoot=$null
$buildRoot=Join-Path $skillRoot 'app'
if(-not [IO.File]::Exists((Join-Path $buildRoot 'install-layout.json'))){
 $repositoryRoot=Split-Path -Parent $skillRoot
 if([IO.File]::Exists((Join-Path $repositoryRoot 'release.json')) -and [IO.File]::Exists((Join-Path $repositoryRoot 'scripts\manage.ps1'))){$buildRoot=$repositoryRoot;$scoutRoot=Split-Path -Parent $repositoryRoot}
 else{$scoutRoot=[IO.Path]::GetFullPath((Join-Path $skillRoot '..\..'));$buildRoot=Join-Path $scoutRoot 'SN-DemoSeeder'}
}
$entry=Join-Path $buildRoot 'scripts\manage.ps1'
$cli=Join-Path $buildRoot 'scripts\cli.cjs'
if(-not [IO.File]::Exists($entry)){throw 'SN DemoLoader runtime is missing. Run the release installer; do not copy SKILL.md alone.'}
if($Action -eq 'Prerequisites'){
 $guide=Join-Path $buildRoot 'PREREQUISITES.html';if(-not [IO.File]::Exists($guide)){throw 'The prerequisites guide is missing. Obtain a complete supported release.'}
 Start-Process ([Uri]$guide).AbsoluteUri
 @{ok=$true;opened='PREREQUISITES.html';sourceRequests=$false}|ConvertTo-Json -Compress
 exit 0
}
if($Action -in @('Diagnose','Recover')){
 $parameters=@{Action=$Action;SkillStore=(Split-Path -Parent $skillRoot)}
 if($scoutRoot){$parameters.OutputRoot=Join-Path $scoutRoot 'SN-DemoSeed-Output'}
 if($Confirm){$parameters.Confirm=$true}
 & (Join-Path $buildRoot 'scripts\install.ps1') @parameters
 exit $LASTEXITCODE
}
if($Action -notin @('Configure','StopConfig')){
 $parameters=@{Action=$Action}
  foreach($key in @('Name','PersonId','Roles','PlanId','PlanHash','InputFile','RecordId','Confirm')){if($PSBoundParameters.ContainsKey($key)){$parameters[$key]=$PSBoundParameters[$key]}}
 & $entry @parameters
 exit $LASTEXITCODE
}
$node=Get-Command node.exe -CommandType Application -ErrorAction Stop
$diagnosticArguments=@();if($Action -eq 'StopConfig'){$diagnosticArguments=@('--diagnostic','true')}
$pathsJson=& $node.Source $cli paths @diagnosticArguments
if($LASTEXITCODE -ne 0){throw 'Cannot resolve installed storage. Inspect the preceding error; no service was started.'}
$paths=$pathsJson|ConvertFrom-Json
$runtime=$paths.runtimeHome
$startup=Join-Path $runtime 'state\config-server.json'
$session=$null
$ownerJson=& $node.Source $cli service-status @diagnosticArguments
if($LASTEXITCODE -ne 0){throw 'Service ownership inspection failed. Run Diagnose; no process was stopped.'}
$ownership=$ownerJson|ConvertFrom-Json
if($ownership.state -eq 'unknown'){throw 'Service ownership is unverified. Run Diagnose; no parallel server or process termination is allowed.'}
function Read-ServerStatus($Candidate){
 $u=[Uri]$Candidate.url
 if($u.Scheme -ne 'http' -or $u.Host -ne '127.0.0.1' -or $u.AbsolutePath -ne '/config-builder.html' -or $u.Fragment -notmatch '^#session=[A-Za-z0-9_-]+$' -or $Candidate.projectRoot -ne $buildRoot -or $Candidate.outputRoot -ne $paths.outputRoot){throw 'A Config Builder belongs to another installation or output library. Stop its verified owner before switching; no parallel server was started.'}
 $headers=@{'X-DemoSeeder-Token'=$u.Fragment.Substring(9)}
 $status=Invoke-RestMethod -Uri ($u.GetLeftPart([UriPartial]::Authority)+'/api/server/status') -Headers $headers -TimeoutSec 5 -MaximumRedirection 0
 if(-not $status.ok -or $status.projectRoot -ne $buildRoot -or $status.outputRoot -ne $paths.outputRoot){throw 'Running Config Builder ownership did not match its saved session.'}
 return $status
}
if($ownership.state -eq 'live'){
 $candidate=Get-Content -LiteralPath $startup -Raw|ConvertFrom-Json
 if($candidate.pid -isnot [long] -and $candidate.pid -isnot [int]){throw 'Stored server process ID is invalid; inspect local state before restarting.'}
 if($candidate.pid -eq $ownership.pid){
  $status=Read-ServerStatus $candidate
  if($Action -eq 'StopConfig'){
   if(-not $Confirm){throw 'StopConfig requires -Confirm. It never interrupts a running source action.'}
   $u=[Uri]$candidate.url
   $null=Invoke-RestMethod -Method Post -Uri ($u.GetLeftPart([UriPartial]::Authority)+'/api/server/stop') -Headers @{'X-DemoSeeder-Token'=$u.Fragment.Substring(9)} -ContentType 'application/json' -Body '{"confirmed":true}' -TimeoutSec 5 -MaximumRedirection 0
   for($attempt=0;$attempt -lt 50;$attempt++){if(-not [IO.File]::Exists($startup)){break};Start-Sleep -Milliseconds 100}
   if([IO.File]::Exists($startup)){throw 'Shutdown was requested but completion was not confirmed. Inspect this exact owner before restarting.'}
   @{ok=$true;stopped=$true;sourceChanges=$false}|ConvertTo-Json -Compress
   exit 0
  }
  if($status.expired -or $status.version -ne $paths.version){throw 'The running Config Builder is expired or from an older release. Run StopConfig -Confirm, then Configure.'}
  $session=$candidate
 }
}
if($Action -eq 'StopConfig'){@{ok=$true;stopped=$false;message='No live Config Builder owner was found. Configure safely archives a confirmed stopped/reused-PID startup record.'}|ConvertTo-Json -Compress;exit 0}
if(-not $session){
 $null=[IO.Directory]::CreateDirectory((Split-Path -Parent $startup))
 $arguments='"'+$cli+'" serve'
 $process=Start-Process -FilePath $node.Source -ArgumentList $arguments -WindowStyle Hidden -PassThru
 for($attempt=0;$attempt -lt 50;$attempt++){
  if($process.HasExited){throw 'Config Builder exited. Inspect state\config-server-error.json in its protected local runtime; no successful source operation was confirmed.'}
  if([IO.File]::Exists($startup)){$candidate=Get-Content -LiteralPath $startup -Raw|ConvertFrom-Json;if($candidate.pid -eq $process.Id){$session=$candidate;break}}
  Start-Sleep -Milliseconds 200
 }
 if(-not $session){throw 'Config Builder did not publish its ready state. Inspect the owned process before retrying.'}
 $status=Read-ServerStatus $session
 if($status.expired){throw 'New Config Builder session was not valid.'}
}
if($OpenBrowser){Start-Process $session.url}
@{ok=$true;processId=$session.pid;outputRoot=$session.outputRoot;opened=[bool]$OpenBrowser;message='Config Builder is ready. Its private session link is stored in protected local startup state.'}|ConvertTo-Json -Compress
