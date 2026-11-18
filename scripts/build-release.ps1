#requires -Version 7.2
[CmdletBinding()]
param(
 [string]$SkillSource,
 [Parameter(Mandatory)][string]$Destination,
 [switch]$Replace
)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'export-ui.ps1')
if(-not $SkillSource){$SkillSource=if([IO.File]::Exists((Join-Path $root 'skill\SKILL.md'))){Join-Path $root 'skill'}else{Join-Path (Split-Path -Parent $root) '_Skills\sn-demoloader'}}
foreach($value in @($Destination,$SkillSource)){if(-not [IO.Path]::IsPathFullyQualified($value)){throw 'Build paths must be absolute.'}}
$release=Get-Content -LiteralPath (Join-Path $root 'release.json') -Raw|ConvertFrom-Json
if($release.version -notmatch '^\d+\.\d+\.\d+$'){throw 'Invalid release version.'}
$name=$release.archivePrefix+'-Scout-'+$release.version
$archive=Join-Path $Destination ($name+'.zip')
if([IO.File]::Exists($archive) -and -not $Replace){throw 'This release archive already exists. Use -Replace only for an intentional rebuild.'}
$staging=Join-Path ([IO.Path]::GetTempPath()) ('sn-release-'+[guid]::NewGuid().ToString('N'))
try{
 $package=Join-Path $staging $name
 $payload=Join-Path $package 'skill'
 $null=[IO.Directory]::CreateDirectory($payload)
 # Deliberate allowlist: never recursively package configs, runs, snapshots or local state.
 $files=@((Get-Content -LiteralPath (Join-Path $root 'package-files.json') -Raw|ConvertFrom-Json).runtime)
 $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
 foreach($relative in $files){if($relative -notmatch '^[A-Za-z0-9_.-]+(\\[A-Za-z0-9_.-]+)*$' -or @($relative.Split('\')|Where-Object {$_ -in @('.','..')}).Count -or -not $seen.Add($relative)){throw 'Invalid or duplicate runtime allowlist path.'}}
 foreach($relative in $files){$source=Join-Path $root $relative;if((Get-Item -LiteralPath $source).LinkType){throw "Linked build file is not packaged: $relative"};$dest=Join-Path (Join-Path $payload 'app') $relative;$null=[IO.Directory]::CreateDirectory((Split-Path -Parent $dest));[IO.File]::Copy($source,$dest,$false)}
 Export-PublicConfigBuilder (Join-Path $root 'config-builder.html') (Join-Path $payload 'app\config-builder.html')
 foreach($relative in @('SKILL.md','scripts\launch.ps1')){$dest=Join-Path $payload $relative;$null=[IO.Directory]::CreateDirectory((Split-Path -Parent $dest));[IO.File]::Copy((Join-Path $SkillSource $relative),$dest,$false)}
 [IO.File]::WriteAllText((Join-Path $payload 'app\install-layout.json'),'{"schemaVersion":1,"product":"sn-demoseeder"}')
 $manifestFiles=@(Get-ChildItem -LiteralPath $payload -Recurse -File|Sort-Object FullName|ForEach-Object {@{path=[IO.Path]::GetRelativePath($payload,$_.FullName);sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}})
 [IO.File]::WriteAllText((Join-Path $package 'package-manifest.json'),(@{schemaVersion=1;product=$release.product;displayName=$release.displayName;skillName=$release.skillName;version=$release.version;files=$manifestFiles}|ConvertTo-Json -Depth 6))
 [IO.File]::Copy((Join-Path $PSScriptRoot 'install.ps1'),(Join-Path $package 'Install-SN-DemoLoader.ps1'),$false)
 [IO.File]::Copy((Join-Path $root 'PREREQUISITES.html'),(Join-Path $package 'PREREQUISITES.html'),$false)
 $readme=[IO.File]::ReadAllText((Join-Path $root 'README.md')).Replace('[INSTALL.txt](INSTALL.txt)','[START-HERE.txt](START-HERE.txt)')
 [IO.File]::WriteAllText((Join-Path $package 'README.md'),$readme)
 $installerHash=(Get-FileHash -LiteralPath (Join-Path $package 'Install-SN-DemoLoader.ps1') -Algorithm SHA256).Hash.ToLowerInvariant()
 $guideHash=(Get-FileHash -LiteralPath (Join-Path $package 'PREREQUISITES.html') -Algorithm SHA256).Hash.ToLowerInvariant()
 $launcher=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'install-launcher.cmd')).Replace('@@INSTALLER_SHA256@@',$installerHash).Replace('@@PREREQUISITES_SHA256@@',$guideHash)
 [IO.File]::WriteAllText((Join-Path $package 'Install.cmd'),$launcher)
 [IO.File]::Copy((Join-Path $root 'INSTALL.txt'),(Join-Path $package 'START-HERE.txt'),$false)
 $null=[IO.Directory]::CreateDirectory($Destination)
 $temporaryArchive=Join-Path $staging ($name+'.zip')
 Add-Type -AssemblyName System.IO.Compression.FileSystem
 [IO.Compression.ZipFile]::CreateFromDirectory($package,$temporaryArchive,[IO.Compression.CompressionLevel]::Optimal,$true)
 [IO.File]::Move($temporaryArchive,$archive,[bool]$Replace)
 @{ok=$true;version=$release.version;archive=$archive;managedFiles=$manifestFiles.Count}|ConvertTo-Json -Compress
}finally{if([IO.Directory]::Exists($staging)){Remove-Item -LiteralPath $staging -Recurse -Force}}
