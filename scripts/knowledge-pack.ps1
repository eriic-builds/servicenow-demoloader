function Pack-Spec($InputData){
 $tables=@('kb_knowledge_base','kb_category','user_criteria','kb_uc_can_read_mtom','kb_uc_can_contribute_mtom','kb_uc_cannot_read_mtom','kb_uc_cannot_contribute_mtom')
 if($InputData.resource -ceq 'packDictionary'){return @{table='sys_dictionary';fields='sys_id,name,element,internal_type,read_only,max_length,reference';query='nameIN'+($tables -join ',')+'^elementINtitle,description,owner,active,label,value,parent_id,parent_table,name,users,groups,roles,companies,locations,departments,advanced,script,match_all,kb_knowledge_base,user_criteria';limit=151}}
 if($InputData.table -cnotin $tables){throw 'INPUT_INVALID'}
 $table=$InputData.table
 $fields=switch($table){
  'kb_knowledge_base' {'sys_id,title,description,owner,active,sys_created_by'}
  'kb_category' {'sys_id,label,value,parent_id,parent_table,active,sys_created_by'}
  'user_criteria' {'sys_id,name,users,groups,roles,companies,locations,departments,advanced,script,match_all,active,sys_created_by'}
  default {'sys_id,kb_knowledge_base,user_criteria,sys_created_by'}
 }
 if($InputData.resource -ceq 'packRelations'){
  if($table -cnotlike 'kb_uc_*' -or $InputData.baseId -isnot [string] -or $InputData.baseId -cnotmatch '^[0-9a-f]{32}$'){throw 'INPUT_INVALID'}
  return @{table=$table;fields=$fields;query='kb_knowledge_base='+$InputData.baseId;limit=21}
 }
 if($InputData.resource -cne 'packLookup' -or $InputData.recordId -isnot [string] -or $InputData.recordId -cnotmatch '^[0-9a-f]{32}$'){throw 'INPUT_INVALID'}
 $query='sys_id='+$InputData.recordId
 if($table -cin @('kb_knowledge_base','user_criteria','kb_category')){
  if($InputData.title -isnot [string] -or [string]::IsNullOrWhiteSpace($InputData.title) -or $InputData.title.Length -gt 100 -or $InputData.title -match '[\^\x00-\x1f\x7f]'){throw 'INPUT_INVALID'}
  if($table -ceq 'kb_knowledge_base'){$query+='^ORtitle='+$InputData.title}
  elseif($table -ceq 'user_criteria'){$query+='^ORname='+$InputData.title}
  else{if($InputData.baseId -isnot [string] -or $InputData.baseId -cnotmatch '^[0-9a-f]{32}$'){throw 'INPUT_INVALID'};$query+='^NQlabel='+$InputData.title+'^parent_id='+$InputData.baseId+'^parent_table=kb_knowledge_base'}
 }
 return @{table=$table;fields=$fields;query=$query;limit=4}
}
function Test-PackAccess($Identity,$Ids,$Person){
 $criteria=Read-Onboarding $Identity @{resource='packLookup';table='user_criteria';recordId=$Ids.criteria;title='Human Resources knowledge contributors';baseId=$Ids.base}
 if($criteria.outcome -cne 'readable' -or $criteria.truncated -or $criteria.rows.Count -ne 1){return $false}
 $row=$criteria.rows[0]
 if($row.sys_id -cne $Ids.criteria -or $row.users -cne $Person.sysId -or $row.sys_created_by -cne $Identity.User -or -not(Test-SourceBoolean $row.active $true) -or -not(Test-SourceBoolean $row.advanced $false) -or -not(Test-SourceBoolean $row.match_all $false)){return $false}
 foreach($key in @('groups','roles','companies','locations','departments','script')){if(-not $row.ContainsKey($key) -or $row[$key] -cne ''){return $false}}
 foreach($table in @('kb_uc_can_read_mtom','kb_uc_can_contribute_mtom','kb_uc_cannot_read_mtom','kb_uc_cannot_contribute_mtom')){
  $links=Read-Onboarding $Identity @{resource='packRelations';table=$table;baseId=$Ids.base}
  if($links.outcome -cne 'readable' -or $links.truncated){return $false}
  if($table -clike 'kb_uc_cannot_*'){if($links.rows.Count){return $false}}
  else{$key=if($table -ceq 'kb_uc_can_read_mtom'){'read'}else{'contribute'};if($links.rows.Count -ne 1 -or $links.rows[0].sys_id -cne $Ids[$key] -or $links.rows[0].kb_knowledge_base -cne $Ids.base -or $links.rows[0].user_criteria -cne $Ids.criteria -or $links.rows[0].sys_created_by -cne $Identity.User){return $false}}
 }
 return $true
}
function KnowledgePack-Operation($Identity,$InputData){
 if($Identity.Purpose -cne 'integration' -or $InputData.operationId -isnot [string] -or $InputData.operationId -cnotmatch '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' -or $InputData.payload -isnot [hashtable] -or $InputData.packIds -isnot [hashtable] -or $InputData.person -isnot [hashtable]){throw 'INPUT_INVALID'}
 $p=$InputData.payload;$ids=$InputData.packIds;$person=$InputData.person;$table=$InputData.table
 foreach($key in @('base','category','criteria','read','contribute')){if($ids[$key] -isnot [string] -or $ids[$key] -cnotmatch '^[0-9a-f]{32}$'){throw 'INPUT_INVALID'}}
 if($p.sys_id -cne $InputData.operationId.Replace('-','') -or $person.sysId -isnot [string] -or $person.sysId -cnotmatch '^[0-9a-f]{32}$'){throw 'INPUT_INVALID'}
 if($table -ceq 'kb_knowledge'){
  if($p.kb_knowledge_base -cne $ids.base -or $p.kb_category -cne $ids.category){throw 'INPUT_INVALID'}
  if($Action -ceq 'DescribeKnowledgePackWrite'){return (Content-Operation $Identity $InputData)}
  if(-not(Test-PackAccess $Identity $ids $person)){return @{ok=$true;outcome='rejected'}}
  $category=Read-Onboarding $Identity @{resource='packLookup';table='kb_category';recordId=$ids.category;title='Time Off and Leave';baseId=$ids.base}
  if($category.outcome -cne 'readable' -or $category.truncated -or $category.rows.Count -ne 1 -or $category.rows[0].sys_id -cne $ids.category -or $category.rows[0].parent_id -cne $ids.base -or $category.rows[0].parent_table -cne 'kb_knowledge_base' -or $category.rows[0].sys_created_by -cne $Identity.User -or -not(Test-SourceBoolean $category.rows[0].active $true)){return @{ok=$true;outcome='rejected'}}
  $base=Read-Onboarding $Identity @{resource='packLookup';table='kb_knowledge_base';recordId=$ids.base;title='Human Resources'}
  if($base.outcome -cne 'readable' -or $base.truncated -or $base.rows.Count -ne 1 -or $base.rows[0].sys_id -cne $ids.base -or $base.rows[0].owner -cne $person.sysId -or $base.rows[0].sys_created_by -cne $Identity.User -or -not(Test-SourceBoolean $base.rows[0].active $true)){return @{ok=$true;outcome='rejected'}}
  return (Content-Operation $Identity $InputData)
 }
 $required=switch($table){
  'kb_knowledge_base' {if($InputData.method -ceq 'PATCH'){@('sys_id','active')}else{@('sys_id','title','description','owner','active')}}
  'user_criteria' {@('sys_id','name','users','groups','roles','companies','locations','departments','advanced','script','match_all','active')}
  'kb_uc_can_read_mtom' {@('sys_id','kb_knowledge_base','user_criteria')}
  'kb_uc_can_contribute_mtom' {@('sys_id','kb_knowledge_base','user_criteria')}
  'kb_category' {@('sys_id','label','value','parent_id','parent_table','active')}
  default {throw 'INPUT_INVALID'}
 }
 if(@($p.Keys|Where-Object {$_ -cnotin $required}).Count -or @($required|Where-Object {-not $p.ContainsKey($_)}).Count){throw 'INPUT_INVALID'}
 if($InputData.method -cnotin @('POST','PATCH') -or ($InputData.method -ceq 'PATCH' -and ($table -cne 'kb_knowledge_base' -or $p.sys_id -cne $ids.base -or -not(Test-SourceBoolean $p.active $true)))){throw 'INPUT_INVALID'}
 if($table -ceq 'kb_knowledge_base' -and $InputData.method -ceq 'POST' -and ($p.sys_id -cne $ids.base -or $p.title -cne 'Human Resources' -or $p.owner -cne $person.sysId -or -not(Test-SourceBoolean $p.active $false))){throw 'INPUT_INVALID'}
 if($table -ceq 'user_criteria'){
  if($p.sys_id -cne $ids.criteria -or $p.name -cne 'Human Resources knowledge contributors' -or $p.users -cne $person.sysId -or -not(Test-SourceBoolean $p.active $true) -or -not(Test-SourceBoolean $p.advanced $false) -or -not(Test-SourceBoolean $p.match_all $false)){throw 'INPUT_INVALID'}
  foreach($key in @('groups','roles','companies','locations','departments','script')){if($p[$key] -cne ''){throw 'INPUT_INVALID'}}
 }
 if($table -clike 'kb_uc_*' -and ($p.kb_knowledge_base -cne $ids.base -or $p.user_criteria -cne $ids.criteria)){throw 'INPUT_INVALID'}
 if($table -ceq 'kb_category' -and ($p.sys_id -cne $ids.category -or $p.parent_id -cne $ids.base -or $p.parent_table -cne 'kb_knowledge_base' -or $p.label -cne 'Time Off and Leave' -or $p.value -cne 'time-off-and-leave' -or -not(Test-SourceBoolean $p.active $true))){throw 'INPUT_INVALID'}
 $spec=Pack-Spec @{resource='packLookup';table=$table;recordId=$p.sys_id;title=$(if($table -ceq 'kb_knowledge_base'){'Human Resources'}elseif($table -ceq 'kb_category'){'Time Off and Leave'}else{'Human Resources knowledge contributors'});baseId=$ids.base}
 $url=$Identity.InstanceUrl+'/api/now/table/'+$table+$(if($InputData.method -ceq 'PATCH'){'/'+$p.sys_id}else{''})+'?sysparm_display_value=false&sysparm_exclude_reference_link=true&sysparm_fields='+[Uri]::EscapeDataString($spec.fields)
 if($Action -ceq 'DescribeKnowledgePackWrite'){return @{ok=$true;method=$InputData.method;url=$url;fields=$p}}
 $actor=Read-Onboarding $Identity @{resource='actor'};$roles=Read-Onboarding $Identity @{resource='roles';roleNames=@('admin')};$grants=Read-Onboarding $Identity @{resource='grants';recordId=$InputData.expectedActorId}
 if($actor.outcome -cne 'readable' -or $actor.truncated -or $actor.rows.Count -ne 1 -or $actor.rows[0].sys_id -cne $InputData.expectedActorId -or $actor.rows[0].user_name -cne $Identity.User -or $actor.rows[0].identity_type -cne $InputData.machineChoice -or -not(Test-SourceBoolean $actor.rows[0].active $true) -or -not(Test-SourceBoolean $actor.rows[0].web_service_access_only $true) -or $roles.outcome -cne 'readable' -or $roles.truncated -or $roles.rows.Count -ne 1 -or $grants.outcome -cne 'readable' -or $grants.truncated -or -not @($grants.rows|Where-Object {$_.user -ceq $InputData.expectedActorId -and $_.role -ceq $roles.rows[0].sys_id}).Count){return @{ok=$true;outcome='rejected'}}
 $people=Read-Onboarding $Identity @{resource='person';targetUser=$person.userName;email=$person.email}
 if($people.outcome -cne 'readable' -or $people.truncated -or $people.rows.Count -ne 1 -or $people.rows[0].sys_id -cne $person.sysId -or $people.rows[0].user_name -cne $person.userName -or $people.rows[0].email -ine $person.email -or $people.rows[0].identity_type -cne $InputData.humanChoice -or -not(Test-SourceBoolean $people.rows[0].active $true) -or -not(Test-SourceBoolean $people.rows[0].web_service_access_only $false)){return @{ok=$true;outcome='rejected'}}
 $dictionary=Read-Onboarding $Identity @{resource='packDictionary'}
 if($dictionary.outcome -cne 'readable' -or $dictionary.truncated){return @{ok=$true;outcome='rejected'}}
 foreach($key in @($p.Keys|Where-Object {$_ -cne 'sys_id'})){$meta=@($dictionary.rows|Where-Object {$_.name -ceq $table -and $_.element -ceq $key});if($meta.Count -ne 1 -or -not(Test-SourceBoolean $meta[0].read_only $false) -or ($p[$key] -is [string] -and $p[$key].Length -gt 0 -and ($meta[0].max_length -notmatch '^\d+$' -or $p[$key].Length -gt [int]$meta[0].max_length))){return @{ok=$true;outcome='rejected'}}}
 $base=Read-Onboarding $Identity @{resource='packLookup';table='kb_knowledge_base';recordId=$ids.base;title='Human Resources'}
 if($table -cne 'kb_knowledge_base' -or $InputData.method -ceq 'PATCH'){
  if($base.outcome -cne 'readable' -or $base.truncated -or $base.rows.Count -ne 1 -or $base.rows[0].sys_id -cne $ids.base -or $base.rows[0].owner -cne $person.sysId -or $base.rows[0].sys_created_by -cne $Identity.User){return @{ok=$true;outcome='rejected'}}
 }
 if($InputData.method -ceq 'PATCH'){
  if(-not(Test-SourceBoolean $base.rows[0].active $false)){return @{ok=$true;outcome='rejected'}}
  if(-not(Test-PackAccess $Identity $ids $person)){return @{ok=$true;outcome='rejected'}}
  $payload=@{active=$true}
 }else{
  if($table -clike 'kb_uc_*'){
   $criteria=Read-Onboarding $Identity @{resource='packLookup';table='user_criteria';recordId=$ids.criteria;title='Human Resources knowledge contributors';baseId=$ids.base}
   if($criteria.outcome -cne 'readable' -or $criteria.truncated -or $criteria.rows.Count -ne 1 -or $criteria.rows[0].sys_id -cne $ids.criteria -or $criteria.rows[0].users -cne $person.sysId -or $criteria.rows[0].sys_created_by -cne $Identity.User -or -not(Test-SourceBoolean $criteria.rows[0].active $true) -or -not(Test-SourceBoolean $criteria.rows[0].advanced $false)){return @{ok=$true;outcome='rejected'}}
   $links=Read-Onboarding $Identity @{resource='packRelations';table=$table;baseId=$ids.base};if($links.outcome -cne 'readable' -or $links.truncated -or $links.rows.Count){return @{ok=$true;outcome='rejected'}}
  }
  $existing=Read-Onboarding $Identity @{resource='packLookup';table=$table;recordId=$p.sys_id;title=$(if($table -ceq 'kb_knowledge_base'){$p.title}elseif($table -ceq 'kb_category'){$p.label}elseif($table -ceq 'user_criteria'){$p.name}else{''});baseId=$ids.base}
  if($existing.outcome -cne 'readable' -or $existing.truncated -or $existing.rows.Count){return @{ok=$true;outcome='rejected'}}
  $payload=$p
 }
 return (Send-MachinePost $Identity $url $payload $spec.fields -Method $InputData.method)
}
