#requires -Version 7.2
[CmdletBinding()]
param([string]$SkillSource,[Parameter(Mandatory)][string]$Destination,[switch]$Replace)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'export-ui.ps1')
if(-not $SkillSource){$SkillSource=if([IO.File]::Exists((Join-Path $root 'skill\SKILL.md'))){Join-Path $root 'skill'}else{Join-Path (Split-Path -Parent $root) '_Skills\sn-demoloader'}}
foreach($value in @($Destination,$SkillSource)){if(-not [IO.Path]::IsPathFullyQualified($value)){throw 'Source build paths must be absolute.'}}
$release=Get-Content -LiteralPath (Join-Path $root 'release.json') -Raw|ConvertFrom-Json
if($release.version -notmatch '^\d+\.\d+\.\d+$'){throw 'Invalid source release version.'}
$layout=Get-Content -LiteralPath (Join-Path $root 'package-files.json') -Raw|ConvertFrom-Json
$name=$release.archivePrefix+'-Source-'+$release.version;$archive=Join-Path $Destination ($name+'.zip')
if([IO.File]::Exists($archive) -and -not $Replace){throw 'Source archive already exists. Use -Replace only for an intentional rebuild.'}
$temporary=Join-Path ([IO.Path]::GetTempPath()) ('sn-source-'+[guid]::NewGuid().ToString('N'))
try{
 $package=Join-Path $temporary $name;$null=[IO.Directory]::CreateDirectory($package)
 $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
 foreach($relative in @($layout.runtime)+@($layout.sourceOnly)){
  if($relative -notmatch '^[A-Za-z0-9_.-]+(\\[A-Za-z0-9_.-]+)*$' -or @($relative.Split('\')|Where-Object {$_ -in @('.','..')}).Count -or -not $seen.Add($relative)){throw 'Invalid or duplicate source allowlist path.'}
  $source=Join-Path $root $relative;if((Get-Item -LiteralPath $source).LinkType){throw 'A linked source file requires explicit review before export.'}
  $target=Join-Path $package $relative;$null=[IO.Directory]::CreateDirectory((Split-Path -Parent $target));[IO.File]::Copy($source,$target,$false)
 }
 foreach($relative in @('SKILL.md','scripts\launch.ps1')){$target=Join-Path (Join-Path $package 'skill') $relative;$null=[IO.Directory]::CreateDirectory((Split-Path -Parent $target));[IO.File]::Copy((Join-Path $SkillSource $relative),$target,$false)}
 Export-PublicConfigBuilder (Join-Path $root 'config-builder.html') (Join-Path $package 'config-builder.html')
 [IO.File]::Copy((Join-Path $root 'REPOSITORY.txt'),(Join-Path $package 'README.txt'),$false)
 [IO.File]::WriteAllText((Join-Path $package '.gitignore'),"configs/`nruns/`nlogs/`nsnapshots/`nreleases/`nnode_modules/`n*.clixml`n*.pfx`n*.pem`n*.key`n.env*`nconfig-server*.json`n*.log`n*.zip`n*.zip.sha256`n")
 $contents=@()
 foreach($file in Get-ChildItem -LiteralPath $package -Recurse -File -Force|Sort-Object FullName){
  $relative=[IO.Path]::GetRelativePath($package,$file.FullName)
  if($relative -match '(^|\\)(configs|runs|logs|snapshots|credentials|state)(\\|$)'){throw 'Operational material cannot enter a source export.'}
  $text=[IO.File]::ReadAllText($file.FullName)
  if($text -match '(?i)https://dev(?!123456\.|12345\.|123\.)\d{6,}\.service-now\.com|(?:m365cpi|diax)\d{6,}\.onmicrosoft\.com'){throw "Instance-specific source material requires removal before export: $relative"}
  $contents+=((Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()+'  '+$relative)
 }
 [IO.File]::WriteAllText((Join-Path $package 'SOURCE-CONTENTS.txt'),(($contents -join [Environment]::NewLine)+[Environment]::NewLine))
 $null=[IO.Directory]::CreateDirectory($Destination);Add-Type -AssemblyName System.IO.Compression.FileSystem
 $stagedArchive=Join-Path $temporary ($name+'.zip');[IO.Compression.ZipFile]::CreateFromDirectory($package,$stagedArchive,[IO.Compression.CompressionLevel]::Optimal,$true);[IO.File]::Move($stagedArchive,$archive,[bool]$Replace)
 @{ok=$true;archive=$archive;version=$release.version;files=$contents.Count+1;published=$false}|ConvertTo-Json -Compress
}finally{if([IO.Directory]::Exists($temporary)){Remove-Item -LiteralPath $temporary -Recurse -Force}}
