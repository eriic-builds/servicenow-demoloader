#requires -Version 7.2
param(
  [ValidateSet('Menu','Paths','Doctor','Profiles','Select','History','Configure','PackPreview','PackStatus','PackApprove','PackApply','PackReconcile','MachinePreview','MachineStatus','MachineApprove','MachineApply','MachineReconcile','PeoplePreview','PeopleStatus','PeopleApprove','PeopleApply','PeopleReconcile','ContentPreview','ContentStatus','ContentApprove','ContentApply','ContentReconcile','KnowledgePreview','KnowledgeStatus','KnowledgeApprove','KnowledgeApply','KnowledgeReconcile')][string]$Action='Menu',
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
$node=Get-Command node.exe -CommandType Application -ErrorAction Stop
$entry=Join-Path $PSScriptRoot 'cli.cjs'
$arguments=@()
switch($Action){
  'PackPreview' {if(-not $Name){throw 'PackPreview requires the selected config name.'};$arguments=@('pack-preview','--name',$Name);if($PersonId){$arguments+=@('--person',$PersonId)}}
  'PackStatus' {$arguments=@('pack-status');if($PlanId){$arguments+=@('--plan',$PlanId)}elseif($Name){$arguments+=@('--name',$Name)}else{throw 'PackStatus requires Name or PlanId.'}}
  'PackApprove' {if(-not $Confirm){throw 'PackApprove requires exact approval of HR content and scoped access changes.'};$arguments=@('pack-approve','--plan',$PlanId,'--hash',$PlanHash,'--confirmed','true')}
  'PackApply' {$arguments=@('pack-apply','--plan',$PlanId,'--hash',$PlanHash)}
  'PackReconcile' {$arguments=@('pack-reconcile','--plan',$PlanId,'--hash',$PlanHash)}
  'Menu' {$arguments=@('menu')}
  'Paths' {$arguments=@('paths')}
  'Doctor' {$arguments=@('doctor')}
  'Profiles' {$arguments=@('profiles')}
  'Select' {if([string]::IsNullOrWhiteSpace($Name)){throw 'Select requires an exact saved config name.'};$arguments=@('use','--name',$Name)}
  'History' {$arguments=@('history')}
  'Configure' {$arguments=@('serve');if($OpenBrowser){$arguments+='--open'}}
  'MachinePreview' {if([string]::IsNullOrWhiteSpace($Name)){throw 'MachinePreview requires the selected config name.'};$arguments=@('machine-preview','--name',$Name);if($Roles.Count){$arguments+=@('--roles',($Roles -join ','))}}
  'MachineStatus' {$arguments=@('machine-status');if($PlanId){$arguments+=@('--plan',$PlanId)}elseif($Name){$arguments+=@('--name',$Name)}else{throw 'MachineStatus requires Name or PlanId.'}}
  'MachineApprove' {if(-not $Confirm){throw 'MachineApprove requires explicit Confirm after reviewing exact changes.'};$arguments=@('machine-approve','--plan',$PlanId,'--hash',$PlanHash,'--confirmed','true')}
  'MachineApply' {$arguments=@('machine-apply','--plan',$PlanId,'--hash',$PlanHash)}
  'MachineReconcile' {$arguments=@('machine-reconcile','--plan',$PlanId,'--hash',$PlanHash)}
  'PeoplePreview' {if([string]::IsNullOrWhiteSpace($Name)){throw 'PeoplePreview requires the selected config name.'};$arguments=@('people-preview','--name',$Name)}
  'PeopleStatus' {$arguments=@('people-status');if($PlanId){$arguments+=@('--plan',$PlanId)}elseif($Name){$arguments+=@('--name',$Name)}else{throw 'PeopleStatus requires Name or PlanId.'}}
  'PeopleApprove' {if(-not $Confirm){throw 'PeopleApprove requires explicit Confirm after reviewing exact changes.'};$arguments=@('people-approve','--plan',$PlanId,'--hash',$PlanHash,'--confirmed','true')}
  'PeopleApply' {$arguments=@('people-apply','--plan',$PlanId,'--hash',$PlanHash)}
  'PeopleReconcile' {$arguments=@('people-reconcile','--plan',$PlanId,'--hash',$PlanHash)}
  'ContentPreview' {if([string]::IsNullOrWhiteSpace($Name) -or [string]::IsNullOrWhiteSpace($InputFile)){throw 'ContentPreview requires Name and a nonsecret normalized InputFile.'};$arguments=@('content-preview','--name',$Name,'--input',$InputFile)}
  'ContentStatus' {$arguments=@('content-status');if($PlanId){$arguments+=@('--plan',$PlanId)}elseif($Name){$arguments+=@('--name',$Name)}else{throw 'ContentStatus requires Name or PlanId.'}}
  'ContentApprove' {if(-not $Confirm){throw 'ContentApprove requires exact user approval before Confirm.'};$arguments=@('content-approve','--plan',$PlanId,'--hash',$PlanHash,'--confirmed','true')}
  'ContentApply' {$arguments=@('content-apply','--plan',$PlanId,'--hash',$PlanHash)}
  'ContentReconcile' {$arguments=@('content-reconcile','--plan',$PlanId,'--hash',$PlanHash)}
  'KnowledgePreview' {if([string]::IsNullOrWhiteSpace($Name) -or [string]::IsNullOrWhiteSpace($RecordId)){throw 'KnowledgePreview requires Name and the exact RecordId.'};$arguments=@('knowledge-preview','--name',$Name,'--record',$RecordId)}
  'KnowledgeStatus' {$arguments=@('knowledge-status');if($PlanId){$arguments+=@('--plan',$PlanId)}elseif($Name){$arguments+=@('--name',$Name)}else{throw 'KnowledgeStatus requires Name or PlanId.'}}
  'KnowledgeApprove' {if(-not $Confirm){throw 'KnowledgeApprove requires exact user approval before Confirm.'};$arguments=@('knowledge-approve','--plan',$PlanId,'--hash',$PlanHash,'--confirmed','true')}
  'KnowledgeApply' {$arguments=@('knowledge-apply','--plan',$PlanId,'--hash',$PlanHash)}
  'KnowledgeReconcile' {$arguments=@('knowledge-reconcile','--plan',$PlanId,'--hash',$PlanHash)}
}
& $node.Source $entry @arguments
exit $LASTEXITCODE
