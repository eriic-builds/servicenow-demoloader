param([Parameter(Mandatory)][ValidateSet('Capture', 'Save', 'Test', 'ReadOnboarding', 'ReadBootstrap', 'DescribeOnboarding', 'BrowserLogin', 'PrepareMachineSecret', 'CreateMachine', 'CreateMachineRole', 'PromoteMachineSecret', 'DescribeMachineWrite', 'CreatePerson', 'CreatePersonRole', 'DescribePersonWrite', 'SetPersonPassword', 'VerifyPersonPassword', 'DescribePersonPassword', 'CreateContent', 'DescribeContentWrite','CreateKnowledgePack','DescribeKnowledgePackWrite')][string]$Action)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
. (Join-Path $PSScriptRoot 'knowledge-pack.ps1')

function Send-Result([hashtable]$Value) {
    [Console]::Out.WriteLine(($Value | ConvertTo-Json -Compress -Depth 8))
}
function Read-BoundedInput {
    $builder = [Text.StringBuilder]::new()
    $buffer = [char[]]::new(1024)
    while (($count = [Console]::In.Read($buffer, 0, $buffer.Length)) -gt 0) {
        if ($builder.Length + $count -gt 65536) { throw 'INPUT_INVALID' }
        [void]$builder.Append($buffer, 0, $count)
    }
    try { return ($builder.ToString() | ConvertFrom-Json -AsHashtable) } catch { throw 'INPUT_INVALID' }
}
function Validate-Input($InputData) {
    if ($InputData -isnot [hashtable]) { throw 'INPUT_INVALID' }
    foreach ($name in @('instanceUrl', 'user', 'purpose', 'filePath')) {
        if (-not $InputData.ContainsKey($name) -or $InputData[$name] -isnot [string]) { throw 'INPUT_INVALID' }
    }
    $uri = $null
    if (-not [Uri]::TryCreate($InputData.instanceUrl, [UriKind]::Absolute, [ref]$uri)) { throw 'INPUT_INVALID' }
    if ($uri.Scheme -cne 'https' -or $uri.Host -cnotmatch '^dev[a-z0-9]+\.service-now\.com$' -or
        $uri.UserInfo -or -not $uri.IsDefaultPort -or $uri.AbsolutePath -cne '/' -or $uri.Query -or $uri.Fragment -or
        $InputData.instanceUrl -cne $uri.GetLeftPart([UriPartial]::Authority)) { throw 'INPUT_INVALID' }
    if ($InputData.purpose -cnotin @('admin', 'integration') -or $InputData.user.Length -gt 256 -or
        [string]::IsNullOrWhiteSpace($InputData.user) -or $InputData.user -match '[:\x00-\x1f\x7f]') { throw 'INPUT_INVALID' }
    if (-not [IO.Path]::IsPathFullyQualified($InputData.filePath)) { throw 'INPUT_INVALID' }
    $fullPath = [IO.Path]::GetFullPath($InputData.filePath)
    $parent = [IO.Path]::GetDirectoryName($fullPath)
    $identityText = $uri.Host + [char]0 + $InputData.user + [char]0 + $InputData.purpose
    $digest = [Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($identityText))
    $key = [Convert]::ToHexString($digest).ToLowerInvariant()
    if ([IO.Path]::GetFileName($fullPath) -cne ($key + '.clixml') -or [IO.Path]::GetFileName($parent) -cne 'credentials') { throw 'INPUT_INVALID' }
    return @{ InstanceUrl = $InputData.instanceUrl; User = $InputData.user; Purpose = $InputData.purpose; File = $fullPath; Directory = $parent }
}
function Identity-Matches($Envelope, $Identity) {
    return ($null -ne $Envelope -and $null -ne $Envelope.PSObject.Properties['InstanceUrl'] -and
        $null -ne $Envelope.PSObject.Properties['User'] -and $null -ne $Envelope.PSObject.Properties['Purpose'] -and
        $null -ne $Envelope.PSObject.Properties['Credential'] -and
        $Envelope.InstanceUrl -ceq $Identity.InstanceUrl -and $Envelope.User -ceq $Identity.User -and
        $Envelope.Purpose -ceq $Identity.Purpose -and $Envelope.Credential -is [pscredential] -and
        $Envelope.Credential.UserName -ceq $Identity.User -and $Envelope.Credential.Password -is [securestring])
}
function Restrict-CredentialDirectory([string]$Directory) {
    [void][IO.Directory]::CreateDirectory($Directory)
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl.SetOwner($sid)
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid,
        [Security.AccessControl.FileSystemRights]::FullControl,
        ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),
        [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
    [void]$acl.AddAccessRule($rule)
    [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($Directory), $acl)
}
function Capture-Credential($Identity) {
    if (-not [Environment]::UserInteractive) { throw 'INTERACTIVE_REQUIRED' }
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    [Windows.Forms.Application]::EnableVisualStyles()
    $form = [Windows.Forms.Form]::new()
    $timer = [Windows.Forms.Timer]::new()
    $passwordBox = $null
    $securePassword = $null
    $credential = $null
    $temporary = $null
    try {
        $form.Text = 'ServiceNow credential - ' + $Identity.Purpose
        $form.ClientSize = [Drawing.Size]::new(580, 335)
        $form.StartPosition = [Windows.Forms.FormStartPosition]::CenterScreen
        $form.FormBorderStyle = [Windows.Forms.FormBorderStyle]::FixedDialog
        $form.MaximizeBox = $false
        $form.MinimizeBox = $false
        $form.AutoScaleMode = [Windows.Forms.AutoScaleMode]::Dpi

        $hostLabel = [Windows.Forms.Label]::new()
        $hostLabel.Location = [Drawing.Point]::new(20, 18)
        $hostLabel.Size = [Drawing.Size]::new(540, 45)
        $hostLabel.Text = 'Instance: ' + $Identity.InstanceUrl
        $hostLabel.UseMnemonic = $false
        $form.Controls.Add($hostLabel)

        $userLabel = [Windows.Forms.TextBox]::new()
        $userLabel.Location = [Drawing.Point]::new(20, 65)
        $userLabel.Size = [Drawing.Size]::new(540, 50)
        $userLabel.Text = 'Exact user: ' + $Identity.User
        $userLabel.ReadOnly = $true
        $userLabel.Multiline = $true
        $userLabel.ScrollBars = [Windows.Forms.ScrollBars]::Vertical
        $userLabel.BorderStyle = [Windows.Forms.BorderStyle]::None
        $form.Controls.Add($userLabel)

        $passwordLabel = [Windows.Forms.Label]::new()
        $passwordLabel.Location = [Drawing.Point]::new(20, 122)
        $passwordLabel.Size = [Drawing.Size]::new(100, 22)
        $passwordLabel.Text = 'Password'
        $form.Controls.Add($passwordLabel)
        $passwordBox = [Windows.Forms.TextBox]::new()
        $passwordBox.Location = [Drawing.Point]::new(120, 120)
        $passwordBox.Size = [Drawing.Size]::new(435, 26)
        $passwordBox.UseSystemPasswordChar = $true
        $passwordBox.MaxLength = 4096
        $form.Controls.Add($passwordBox)

        $remember = [Windows.Forms.CheckBox]::new()
        $remember.Location = [Drawing.Point]::new(20, 164)
        $remember.Size = [Drawing.Size]::new(540, 26)
        $remember.Text = 'Remember encrypted for this Windows user on this PC'
        $remember.Checked = $false
        $form.Controls.Add($remember)

        $note = [Windows.Forms.Label]::new()
        $note.Location = [Drawing.Point]::new(20, 201)
        $note.Size = [Drawing.Size]::new(540, 65)
        $note.Text = 'Unchecked: this password is not saved; any previous saved copy for this identity is removed. This dialog does not sign in or test permissions. It closes after five minutes.'
        $form.Controls.Add($note)

        $continue = [Windows.Forms.Button]::new()
        $continue.Location = [Drawing.Point]::new(350, 286)
        $continue.Size = [Drawing.Size]::new(100, 30)
        $continue.Text = 'Continue'
        $continue.Add_Click({
            if ($passwordBox.Text.Length -eq 0) {
                [void][Windows.Forms.MessageBox]::Show($form, 'Enter a password or choose Cancel.', 'Password required',
                    [Windows.Forms.MessageBoxButtons]::OK, [Windows.Forms.MessageBoxIcon]::Information)
            } else {
                $form.DialogResult = [Windows.Forms.DialogResult]::OK
                $form.Close()
            }
        })
        $form.Controls.Add($continue)
        $form.AcceptButton = $continue
        $cancel = [Windows.Forms.Button]::new()
        $cancel.Location = [Drawing.Point]::new(460, 286)
        $cancel.Size = [Drawing.Size]::new(100, 30)
        $cancel.Text = 'Cancel'
        $cancel.DialogResult = [Windows.Forms.DialogResult]::Cancel
        $form.Controls.Add($cancel)
        $form.CancelButton = $cancel
        $form.Add_Shown({ [void]$passwordBox.Focus() })
        $timer.Interval = 300000
        $timer.Add_Tick({
            $form.DialogResult = [Windows.Forms.DialogResult]::Cancel
            $form.Close()
        })
        $timer.Start()
        $result = $form.ShowDialog()
        $timer.Stop()
        if ($result -ne [Windows.Forms.DialogResult]::OK) { return @{ ok = $true; saved = $false; cancelled = $true } }
        if (-not $remember.Checked) {
            try { [IO.File]::Delete($Identity.File) } catch { throw 'CREDENTIAL_SAVE_FAILED' }
            return @{ ok = $true; saved = $false }
        }
        return (Save-Credential $Identity $passwordBox.Text)
    } finally {
        $timer.Stop()
        $timer.Dispose()
        if ($null -ne $passwordBox) { $passwordBox.Clear() }
        $form.Dispose()
        if ($null -ne $securePassword) { $securePassword.Dispose() }
        $credential = $null
        if ($temporary -and [IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
    }
}
function Save-Credential($Identity, $Password) {
    if ($Password -isnot [string] -or $Password.Length -lt 1 -or $Password.Length -gt 4096 -or $Password.Contains([char]0)) { throw 'INPUT_INVALID' }
    $secure = $null; $reopened = $null; $temporary = $null
    try {
        $secure = ConvertTo-SecureString -String $Password -AsPlainText -Force
        $Password = $null
        $envelope = [pscustomobject]@{InstanceUrl=$Identity.InstanceUrl;User=$Identity.User;Purpose=$Identity.Purpose;Credential=[pscredential]::new($Identity.User,$secure)}
        Restrict-CredentialDirectory $Identity.Directory
        $temporary = $Identity.File + '.' + [Guid]::NewGuid().ToString('N') + '.new'
        $envelope | Export-Clixml -LiteralPath $temporary -Encoding utf8 -Depth 5
        $reopened = Import-Clixml -LiteralPath $temporary
        if (-not (Identity-Matches $reopened $Identity)) { throw 'CREDENTIAL_SAVE_FAILED' }
        if ([IO.File]::ReadAllText($temporary) -notmatch '<SS\s+N="Password">[0-9a-f]+</SS>') { throw 'CREDENTIAL_SAVE_FAILED' }
        [IO.File]::Move($temporary, $Identity.File, $true)
        $temporary = $null
        return @{ok=$true;saved=$true}
    } catch { throw 'CREDENTIAL_SAVE_FAILED' }
    finally {
        $Password = $null
        if($null -ne $secure){$secure.Dispose()}
        if($null -ne $reopened){$reopened.Credential.Password.Dispose()}
        if($temporary -and [IO.File]::Exists($temporary)){[IO.File]::Delete($temporary)}
    }
}
function Pdi-Result([string]$Status, [string]$Outcome) {
    $result = @{ ok = $true; status = $Status; outcome = $Outcome; checkedAt = [DateTime]::UtcNow.ToString('o'); writeAccessTested = $false }
    if ($Outcome -ceq 'empty') { $result.visibleSampleCount = 0 }
    if ($Outcome -ceq 'readable') { $result.visibleSampleCount = 1 }
    return $result
}
function Test-Credential($Identity) {
    if (-not [IO.File]::Exists($Identity.File)) { return (Pdi-Result 'unknown' 'missing') }
    $envelope = $null
    try { $envelope = Import-Clixml -LiteralPath $Identity.File } catch { return (Pdi-Result 'unknown' 'unreadable') }
    if (-not (Identity-Matches $envelope $Identity)) { return (Pdi-Result 'blocked' 'identityMismatch') }
    $handler = [Net.Http.HttpClientHandler]::new()
    $handler.AllowAutoRedirect = $false
    $handler.UseCookies = $false
    $client = [Net.Http.HttpClient]::new($handler)
    $client.Timeout = [TimeSpan]::FromSeconds(25)
    $bodyTimeout = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds(25))
    $request = $null
    $response = $null
    $bytes = $null
    $plain = $null
    $stream = $null
    try {
        $plain = $envelope.Credential.GetNetworkCredential().Password
        $bytes = [Text.Encoding]::UTF8.GetBytes($Identity.User + ':' + $plain)
        $authorization = [Convert]::ToBase64String($bytes)
        [Array]::Clear($bytes, 0, $bytes.Length)
        $bytes = $null
        $plain = $null
        $url = $Identity.InstanceUrl + '/api/now/table/incident?sysparm_limit=1&sysparm_fields=sys_id'
        $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Get, $url)
        $request.Headers.Authorization = [Net.Http.Headers.AuthenticationHeaderValue]::new('Basic', $authorization)
        $authorization = $null
        $request.Headers.Accept.ParseAdd('application/json')
        $response = $client.SendAsync($request, [Net.Http.HttpCompletionOption]::ResponseHeadersRead, $bodyTimeout.Token).GetAwaiter().GetResult()
        $status = [int]$response.StatusCode
        if ($status -eq 401) { return (Pdi-Result 'blocked' 'unauthorized') }
        if ($status -eq 403) { return (Pdi-Result 'blocked' 'forbidden') }
        if ($status -ge 300 -and $status -lt 400) { return (Pdi-Result 'unknown' 'redirect') }
        if ($status -ne 200) { return (Pdi-Result 'unknown' 'response') }
        $stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $memory = [IO.MemoryStream]::new()
        $buffer = [byte[]]::new(4096)
        # The same deadline covers headers and body; ResponseHeadersRead alone does not.
        try {
            while (($count = $stream.ReadAsync($buffer, 0, $buffer.Length, $bodyTimeout.Token).GetAwaiter().GetResult()) -gt 0) {
                if ($memory.Length + $count -gt 1048576) { return (Pdi-Result 'unknown' 'response') }
                $memory.Write($buffer, 0, $count)
            }
            try { $body = [Text.Encoding]::UTF8.GetString($memory.ToArray()) | ConvertFrom-Json -AsHashtable } catch { return (Pdi-Result 'unknown' 'response') }
            if ($body -isnot [hashtable] -or -not $body.ContainsKey('result') -or $body.result -isnot [array] -or $body.result.Count -gt 1) { return (Pdi-Result 'unknown' 'response') }
            if ($body.result.Count -eq 0) { return (Pdi-Result 'authenticated' 'empty') }
            if ($body.result[0] -isnot [hashtable] -or -not $body.result[0].ContainsKey('sys_id') -or $body.result[0].sys_id -isnot [string] -or $body.result[0].sys_id -notmatch '^[0-9a-f]{32}$') { return (Pdi-Result 'unknown' 'response') }
            return (Pdi-Result 'authenticated' 'readable')
        } finally {
            $memory.Dispose()
        }
    } catch { return (Pdi-Result 'unknown' 'network') }
    finally {
        if ($null -ne $bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
        $plain = $null
        if ($null -ne $stream) { $stream.Dispose() }
        if ($null -ne $response) { $response.Dispose() }
        if ($null -ne $request) { $request.Dispose() }
        $bodyTimeout.Dispose()
        $client.Dispose()
        $envelope.Credential.Password.Dispose()
        $envelope = $null
    }
}

function Browser-Login($Identity, $InputData) {
    if ($Identity.Purpose -cne 'admin' -or $InputData.debuggerUrl -isnot [string] -or $InputData.sessionDirectory -isnot [string]) { throw 'INPUT_INVALID' }
    $endpoint = $null
    if (-not [Uri]::TryCreate($InputData.debuggerUrl, [UriKind]::Absolute, [ref]$endpoint) -or $endpoint.Scheme -cne 'ws' -or $endpoint.Host -cne '127.0.0.1' -or $endpoint.UserInfo -or $endpoint.Query -or $endpoint.Fragment -or $endpoint.AbsolutePath -cnotmatch '^/devtools/page/[A-Za-z0-9-]+$') { throw 'INPUT_INVALID' }
    $session = [IO.Path]::GetFullPath($InputData.sessionDirectory)
    $allowed = [IO.Path]::Combine([IO.Path]::GetDirectoryName($Identity.Directory), 'browsers') + [IO.Path]::DirectorySeparatorChar
    if (-not $session.StartsWith($allowed, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($session) -cnotmatch '^admin-[A-Za-z0-9]+$') { throw 'INPUT_INVALID' }
    $portLines = [IO.File]::ReadAllLines([IO.Path]::Combine($session, 'DevToolsActivePort'))
    if ($portLines.Length -lt 2 -or $portLines[0] -cne [string]$endpoint.Port -or $portLines[1] -cnotmatch '^/devtools/browser/[A-Za-z0-9-]+$') { throw 'INPUT_INVALID' }
    if (-not [IO.File]::Exists($Identity.File)) { return @{ ok = $true; outcome = 'missing' } }
    try { $envelope = Import-Clixml -LiteralPath $Identity.File } catch { return @{ ok = $true; outcome = 'unreadable' } }
    if (-not (Identity-Matches $envelope $Identity)) { return @{ ok = $true; outcome = 'identityMismatch' } }
    $socket = [Net.WebSockets.ClientWebSocket]::new()
    $deadline = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds(25))
    function Send-Cdp([string]$Method, [hashtable]$Parameters) {
        $script:browserCommandId++
        $id = $script:browserCommandId
        $serialized = @{ id = $id; method = $Method; params = $Parameters } | ConvertTo-Json -Compress -Depth 10
        $bytes = [Text.Encoding]::UTF8.GetBytes($serialized)
        try { [void]$socket.SendAsync([ArraySegment[byte]]::new($bytes), [Net.WebSockets.WebSocketMessageType]::Text, $true, $deadline.Token).GetAwaiter().GetResult() }
        finally { [Array]::Clear($bytes, 0, $bytes.Length); $serialized = $null }
        while ($true) {
            $memory = [IO.MemoryStream]::new()
            try {
                $buffer = [byte[]]::new(4096)
                do {
                    $part = $socket.ReceiveAsync([ArraySegment[byte]]::new($buffer), $deadline.Token).GetAwaiter().GetResult()
                    if ($part.MessageType -eq [Net.WebSockets.WebSocketMessageType]::Close -or $memory.Length + $part.Count -gt 262144) { throw 'HELPER_PROTOCOL' }
                    $memory.Write($buffer, 0, $part.Count)
                } while (-not $part.EndOfMessage)
                $message = [Text.Encoding]::UTF8.GetString($memory.ToArray()) | ConvertFrom-Json -AsHashtable
                if ($message.ContainsKey('id') -and $message.id -eq $id) {
                    if ($message.ContainsKey('error') -or -not $message.ContainsKey('result')) { throw 'HELPER_PROTOCOL' }
                    return $message.result
                }
            } finally { $memory.Dispose() }
        }
    }
    try {
        $script:browserCommandId = 0
        [void]$socket.ConnectAsync($endpoint, $deadline.Token).GetAwaiter().GetResult()
        $global = Send-Cdp 'Runtime.evaluate' @{ expression = 'globalThis'; returnByValue = $false }
        if (-not $global.ContainsKey('result') -or -not $global.result.ContainsKey('objectId')) { throw 'HELPER_PROTOCOL' }
        $function = @'
function(origin, username, password) {
  if (location.origin !== origin) return 'interactiveRequired';
  const user = document.getElementById('user_name'), pass = document.getElementById('user_password'), login = document.getElementById('sysverb_login');
  if (!user || !pass || !login || !user.form || user.form !== pass.form) return 'interactiveRequired';
  const action = new URL(user.form.action || location.href, location.href);
  if (action.origin !== origin || action.pathname !== '/login.do' || user.form.method.toLowerCase() !== 'post') return 'interactiveRequired';
  user.value = username; pass.value = password;
  user.dispatchEvent(new Event('input', {bubbles:true})); pass.dispatchEvent(new Event('input', {bubbles:true}));
  login.click(); return 'submitted';
}
'@
        $arguments = @(@{ value = $Identity.InstanceUrl }, @{ value = $Identity.User }, @{ value = $envelope.Credential.GetNetworkCredential().Password })
        try { $result = Send-Cdp 'Runtime.callFunctionOn' @{ functionDeclaration = $function; objectId = $global.result.objectId; arguments = $arguments; returnByValue = $true } }
        finally { $arguments = $null }
        if ($result.ContainsKey('exceptionDetails') -or -not $result.ContainsKey('result') -or -not $result.result.ContainsKey('value') -or $result.result.value -cnotin @('submitted','interactiveRequired')) { throw 'HELPER_PROTOCOL' }
        return @{ ok = $true; outcome = $result.result.value }
    } catch {
        if ($_.Exception.Message -ceq 'HELPER_PROTOCOL') { throw 'HELPER_PROTOCOL' }
        if ($deadline.IsCancellationRequested) { throw 'TIMED_OUT' }
        throw 'HELPER_FAILED'
    } finally {
        $deadline.Dispose(); $socket.Dispose(); $envelope.Credential.Password.Dispose(); $envelope = $null
    }
}

function Read-Onboarding($Identity, $InputData) {
    $resource = $InputData.resource
    if ($resource -cnotin @('actor', 'machine', 'dictionary', 'choices', 'roles', 'roleIds', 'grants', 'incident', 'knowledge','person','peopleDictionary','passwordDictionary','contentDictionary','contentChoices','knowledgeBases','contentLookup','knowledgePublication','packDictionary','packLookup','packRelations')) { throw 'INPUT_INVALID' }
    if ($resource -cin @('person','peopleDictionary','passwordDictionary') -and $Action -cnotin @('ReadBootstrap','CreatePerson','CreatePersonRole','SetPersonPassword','VerifyPersonPassword','CreateContent','CreateKnowledgePack')) { throw 'INPUT_INVALID' }
    if ($resource -cin @('contentDictionary','contentChoices','knowledgeBases','contentLookup') -and $Action -cnotin @('ReadBootstrap','CreateContent','CreateKnowledgePack')) { throw 'INPUT_INVALID' }
    if ($resource -cin @('packDictionary','packLookup','packRelations') -and $Action -cnotin @('ReadBootstrap','CreateKnowledgePack','DescribeKnowledgePackWrite')){throw 'INPUT_INVALID'}
    if($resource -ceq 'knowledgePublication' -and $Action -cne 'ReadBootstrap'){throw 'INPUT_INVALID'}
    if ($Action -ceq 'CreateContent' -and $resource -cnotin @('actor','roles','grants','person','contentLookup','contentDictionary','contentChoices','knowledgeBases')) { throw 'INPUT_INVALID' }
    $table = ''; $fields = ''; $query = ''; $limit = 201
    switch ($resource) {
        {$_ -cin @('packDictionary','packLookup','packRelations')} {$spec=Pack-Spec $InputData;$table=$spec.table;$fields=$spec.fields;$query=$spec.query;$limit=$spec.limit}
        'actor' { if ($Identity.User -cnotmatch '^[A-Za-z0-9_.@-]{1,120}$') { throw 'INPUT_INVALID' }; $table = 'sys_user'; $fields = 'sys_id,user_name,active,identity_type,web_service_access_only'; $query = 'user_name=' + $Identity.User; $limit = 2 }
        'machine' { if ($InputData.targetUser -isnot [string] -or $InputData.targetUser -cnotmatch '^[A-Za-z0-9_.@-]{1,120}$') { throw 'INPUT_INVALID' }; $table = 'sys_user'; $fields = 'sys_id,user_name,active,identity_type,web_service_access_only,source'; $query = 'user_name=' + $InputData.targetUser; $limit = 2 }
        'dictionary' { $table = 'sys_dictionary'; $fields = 'sys_id,name,element,internal_type,read_only,unique,max_length'; $query = 'name=sys_user^elementINuser_name,active,identity_type,web_service_access_only,source,user_password,password_needs_reset'; $limit = 20 }
        'peopleDictionary' { $table='sys_dictionary';$fields='sys_id,name,element,internal_type,read_only,unique,max_length';$query='name=sys_user^elementINuser_name,email,first_name,last_name,active,identity_type,web_service_access_only,source';$limit=20 }
        'passwordDictionary' { $table='sys_dictionary';$fields='sys_id,name,element,internal_type,read_only,max_length';$query='name=sys_user^elementINuser_password,password_needs_reset';$limit=4 }
        'contentDictionary' { $table='sys_dictionary';$fields='sys_id,name,element,internal_type,read_only,max_length,reference';$query='nameINtask,incident,kb_knowledge^elementINshort_description,description,caller_id,assigned_to,assignment_group,impact,urgency,state,category,correlation_id,text,author,kb_knowledge_base,kb_category,workflow_state,active';$limit=101 }
        'contentChoices' { $table='sys_choice';$fields='sys_id,name,element,value,label,language,inactive';$query='nameINtask,incident,kb_knowledge^elementINstate,category,impact,urgency,workflow_state^language=en^inactive=false';$limit=201 }
        'knowledgeBases' { $table='kb_knowledge_base';$fields='sys_id,title,active';$query='active=true';$limit=101 }
        'knowledgePublication' {
            if($InputData.recordId -isnot [string] -or $InputData.recordId -cnotmatch '^[0-9a-f]{32}$'){throw 'INPUT_INVALID'}
            $table='kb_knowledge';$fields='sys_id,number,short_description,text,author,kb_knowledge_base,kb_category,workflow_state,active,latest,article_id,version,valid_to,sys_mod_count,sys_updated_by';$query='sys_id='+$InputData.recordId;$limit=2
        }
        'contentLookup' {
            if($InputData.table -cnotin @('incident','kb_knowledge') -or $InputData.recordId -isnot [string] -or $InputData.recordId -cnotmatch '^[0-9a-f]{32}$' -or $InputData.title -isnot [string] -or [string]::IsNullOrWhiteSpace($InputData.title) -or $InputData.title.Length -gt 160 -or $InputData.title -match '[\^\x00-\x1f\x7f]'){throw 'INPUT_INVALID'}
            $table=$InputData.table;$limit=4
            if($table -ceq 'incident'){
                if($InputData.marker -isnot [string] -or $InputData.marker -cnotmatch '^SNDS:[0-9a-f-]{36}$'){throw 'INPUT_INVALID'}
                $fields='sys_id,number,short_description,description,caller_id,assigned_to,assignment_group,category,impact,urgency,state,correlation_id,sys_created_by,sys_mod_count'
                $query='sys_id='+$InputData.recordId+'^ORcorrelation_id='+$InputData.marker+'^ORshort_description='+$InputData.title
            }else{
                if($InputData.baseId -isnot [string] -or $InputData.baseId -cnotmatch '^[0-9a-f]{32}$'){throw 'INPUT_INVALID'}
                $fields='sys_id,number,short_description,text,author,kb_knowledge_base,kb_category,workflow_state,active,sys_created_by,sys_mod_count'
                $query='sys_id='+$InputData.recordId+'^NQshort_description='+$InputData.title+'^kb_knowledge_base='+$InputData.baseId
            }
        }
        'person' {
            if ($InputData.targetUser -isnot [string] -or $InputData.targetUser -cnotmatch '^[A-Za-z0-9_.@+-]{1,120}$' -or $InputData.email -isnot [string] -or $InputData.email.Length -gt 254 -or $InputData.email -cnotmatch '^[a-z0-9._%+-]+@[a-z0-9.-]+$') { throw 'INPUT_INVALID' }
            $table='sys_user';$fields='sys_id,user_name,email,first_name,last_name,active,identity_type,web_service_access_only,source';$query='user_name='+$InputData.targetUser+'^ORemail='+$InputData.email;$limit=4
        }
        'choices' { $table = 'sys_choice'; $fields = 'sys_id,name,element,value,label,inactive,language'; $query = 'name=sys_user^element=identity_type^inactive=false^language=en' }
        'roles' { if ($InputData.roleNames -isnot [array] -or $InputData.roleNames.Count -gt 6) { throw 'INPUT_INVALID' }; foreach ($name in $InputData.roleNames) { if ($name -cnotin @('admin','itil','knowledge','knowledge_admin','itil_admin')) { throw 'INPUT_INVALID' } }; $table = 'sys_user_role'; $fields = 'sys_id,name'; $query = 'nameIN' + ($InputData.roleNames -join ','); $limit = 20 }
        'roleIds' { if ($InputData.roleIds -isnot [array] -or $InputData.roleIds.Count -lt 1 -or $InputData.roleIds.Count -gt 200) { throw 'INPUT_INVALID' }; foreach ($id in $InputData.roleIds) { if ($id -isnot [string] -or $id -cnotmatch '^[0-9a-f]{32}$') { throw 'INPUT_INVALID' } }; $table = 'sys_user_role'; $fields = 'sys_id,name'; $query = 'sys_idIN' + ($InputData.roleIds -join ',') }
        'grants' { if ($InputData.recordId -isnot [string] -or $InputData.recordId -cnotmatch '^[0-9a-f]{32}$') { throw 'INPUT_INVALID' }; $table = 'sys_user_has_role'; $fields = 'sys_id,user,role,inherited'; $query = 'user=' + $InputData.recordId }
        'incident' { $table = 'incident'; $fields = 'sys_id'; $limit = 1 }
        'knowledge' { $table = 'kb_knowledge'; $fields = 'sys_id'; $limit = 1 }
    }
    if ($Identity.Purpose -ceq 'integration' -and $resource -cnotin @('actor','incident','knowledge') -and $Action -cnotin @('ReadBootstrap','CreatePerson','CreatePersonRole','SetPersonPassword','VerifyPersonPassword','CreateContent','CreateKnowledgePack')) { throw 'INPUT_INVALID' }
    if ($Action -ceq 'ReadBootstrap' -and $Identity.Purpose -cne 'integration') { throw 'INPUT_INVALID' }
    $url = $Identity.InstanceUrl + '/api/now/table/' + $table + '?sysparm_display_value=false&sysparm_exclude_reference_link=true&sysparm_limit=' + $limit + '&sysparm_fields=' + [Uri]::EscapeDataString($fields)
    if ($query) { $url += '&sysparm_query=' + [Uri]::EscapeDataString($query) }
    if ($Action -ceq 'DescribeOnboarding') { return @{ ok = $true; url = $url; fields = @($fields.Split(',')); limit = $limit } }
    if (-not [IO.File]::Exists($Identity.File)) { return @{ ok = $true; outcome = 'missing' } }
    try { $envelope = Import-Clixml -LiteralPath $Identity.File } catch { return @{ ok = $true; outcome = 'unreadable' } }
    if (-not (Identity-Matches $envelope $Identity)) { return @{ ok = $true; outcome = 'identityMismatch' } }
    $handler = [Net.Http.HttpClientHandler]::new()
    $handler.AllowAutoRedirect = $false
    $handler.UseCookies = $false
    $client = [Net.Http.HttpClient]::new($handler)
    $client.Timeout = [TimeSpan]::FromSeconds(25)
    $deadline = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds(25))
    $request = $null; $response = $null; $stream = $null; $bytes = $null
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($Identity.User + ':' + $envelope.Credential.GetNetworkCredential().Password)
        $authorization = [Convert]::ToBase64String($bytes)
        [Array]::Clear($bytes, 0, $bytes.Length); $bytes = $null
        $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Get, $url)
        $request.Headers.Authorization = [Net.Http.Headers.AuthenticationHeaderValue]::new('Basic', $authorization)
        $authorization = $null
        $request.Headers.Accept.ParseAdd('application/json')
        $response = $client.SendAsync($request, [Net.Http.HttpCompletionOption]::ResponseHeadersRead, $deadline.Token).GetAwaiter().GetResult()
        $status = [int]$response.StatusCode
        if ($status -eq 401) { return @{ ok = $true; outcome = 'unauthorized' } }
        if ($status -eq 403) { return @{ ok = $true; outcome = 'forbidden' } }
        if ($status -ge 300 -and $status -lt 400) { return @{ ok = $true; outcome = 'interactiveRequired' } }
        if ($status -ne 200) { return @{ ok = $true; outcome = 'response' } }
        $stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $memory = [IO.MemoryStream]::new()
        try {
            $buffer = [byte[]]::new(4096)
            while (($count = $stream.ReadAsync($buffer, 0, $buffer.Length, $deadline.Token).GetAwaiter().GetResult()) -gt 0) {
                if ($memory.Length + $count -gt 1048576) { return @{ ok = $true; outcome = 'response' } }
                $memory.Write($buffer, 0, $count)
            }
            try { $body = [Text.Encoding]::UTF8.GetString($memory.ToArray()) | ConvertFrom-Json -AsHashtable } catch { return @{ ok = $true; outcome = 'interactiveRequired' } }
            if ($body -isnot [hashtable] -or -not $body.ContainsKey('result') -or $body.result -isnot [array] -or $body.result.Count -gt $limit) { return @{ ok = $true; outcome = 'response' } }
            $rows = @()
            foreach ($row in $body.result) {
                if ($row -isnot [hashtable]) { return @{ ok = $true; outcome = 'response' } }
                $safe = @{}
                foreach ($field in $fields.Split(',')) {
                    if ($row.ContainsKey($field)) {
                        $value = $row[$field]
                        if ($field -in @('user','role','internal_type','caller_id','assigned_to','assignment_group','author','kb_knowledge_base','kb_category','owner','parent_id','user_criteria') -and $value -is [hashtable] -and $value.ContainsKey('value')) { $value = $value.value }
                        $safe[$field] = $value
                    }
                }
                $rows += $safe
            }
            return @{ ok = $true; outcome = 'readable'; rows = $rows; truncated = ($rows.Count -eq $limit -and $limit -ne 1) }
        } finally { $memory.Dispose() }
    } catch {
        $cause = $_.Exception
        while ($null -ne $cause.InnerException) { $cause = $cause.InnerException }
        if ($cause -is [Net.Http.HttpRequestException] -or $cause -is [IO.IOException] -or $cause -is [OperationCanceledException]) { return @{ ok = $true; outcome = 'network' } }
        throw 'HELPER_FAILED'
    }
    finally {
        if ($null -ne $bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
        if ($null -ne $stream) { $stream.Dispose() }
        if ($null -ne $response) { $response.Dispose() }
        if ($null -ne $request) { $request.Dispose() }
        $deadline.Dispose(); $client.Dispose()
        $envelope.Credential.Password.Dispose(); $envelope = $null
    }
}

function Test-SourceBoolean($Value, [bool]$Expected) {
    if ($Value -is [bool]) { return $Value -eq $Expected }
    if ($Value -is [string]) { return $Value -ceq $Expected.ToString().ToLowerInvariant() }
    return $false
}
function Machine-Operation($Identity, $InputData) {
    if ($Identity.Purpose -cne 'admin' -or $InputData.operationId -isnot [string] -or $InputData.operationId -cnotmatch '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' -or
        $InputData.targetUser -isnot [string] -or $InputData.targetUser -cnotmatch '^[A-Za-z0-9_.@-]{1,120}$' -or $InputData.targetUser -ieq $Identity.User -or
        $InputData.recordId -cne $InputData.operationId.Replace('-', '') -or $InputData.machineChoice -isnot [string] -or $InputData.machineChoice -cnotmatch '^[A-Za-z0-9_-]{1,80}$') { throw 'INPUT_INVALID' }
    $targetKeyText = ([Uri]$Identity.InstanceUrl).Host + [char]0 + $InputData.targetUser + [char]0 + 'integration'
    $targetKey = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($targetKeyText))).ToLowerInvariant()
    $pendingDirectory = [IO.Path]::Combine($Identity.Directory, 'machine-pending')
    $pendingFile = [IO.Path]::Combine($pendingDirectory, $InputData.operationId + '.clixml')
    $target = @{InstanceUrl=$Identity.InstanceUrl;User=$InputData.targetUser;Purpose='integration';Directory=$Identity.Directory;File=[IO.Path]::Combine($Identity.Directory,$targetKey+'.clixml')}
    $staged = @{InstanceUrl=$target.InstanceUrl;User=$target.User;Purpose=$target.Purpose;Directory=$pendingDirectory;File=$pendingFile}
    $isRole = $Action -ceq 'CreateMachineRole' -or ($Action -ceq 'DescribeMachineWrite' -and $InputData.ContainsKey('roleId'))
    if ($isRole -and ($InputData.roleId -isnot [string] -or $InputData.roleId -cnotmatch '^[0-9a-f]{32}$' -or $InputData.grantId -isnot [string] -or $InputData.grantId -cnotmatch '^[0-9a-f]{32}$')) { throw 'INPUT_INVALID' }
    $fields = if ($isRole) { 'sys_id,user,role' } else { 'sys_id,user_name,active,identity_type,web_service_access_only,source' }
    $table = if ($isRole) { 'sys_user_has_role' } else { 'sys_user' }
    $payload = if ($isRole) { @{sys_id=$InputData.grantId;user=$InputData.recordId;role=$InputData.roleId} } else {
        @{sys_id=$InputData.recordId;user_name=$InputData.targetUser;active=$true;identity_type=$InputData.machineChoice;web_service_access_only=$true;source=('SN-DemoSeeder:'+$InputData.operationId);password_needs_reset=$false}
    }
    $url = $Identity.InstanceUrl + '/api/now/table/' + $table + '?sysparm_display_value=false&sysparm_exclude_reference_link=true&sysparm_fields=' + [Uri]::EscapeDataString($fields)
    if ($Action -ceq 'DescribeMachineWrite') { return @{ok=$true;method='POST';url=$url;fields=$payload;passwordHandling='independently-generated-DPAPI-pending-no-password-output'} }
    $secretEnvelope = $null; $existingEnvelope = $null
    try {
        if ($Action -ceq 'PrepareMachineSecret' -and -not [IO.File]::Exists($pendingFile)) {
            if ([IO.File]::Exists($target.File)) { throw 'MACHINE_SECRET_EXISTS' }
            $generated = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(48)) + 'aA1!'
            try { [void](Save-Credential $staged $generated) } finally { $generated = $null }
        }
        if (-not [IO.File]::Exists($pendingFile)) { throw 'MACHINE_SECRET_MISSING' }
        $secretEnvelope = Import-Clixml -LiteralPath $pendingFile
        if (-not (Identity-Matches $secretEnvelope $target)) { throw 'MACHINE_SECRET_MISSING' }
        if ($Action -ceq 'PrepareMachineSecret') { return @{ok=$true;outcome='prepared'} }
        if ($Action -ceq 'PromoteMachineSecret') {
            Restrict-CredentialDirectory $Identity.Directory
            if ([IO.File]::Exists($target.File)) {
                $existingEnvelope = Import-Clixml -LiteralPath $target.File
                if (-not (Identity-Matches $existingEnvelope $target) -or $existingEnvelope.Credential.GetNetworkCredential().Password -cne $secretEnvelope.Credential.GetNetworkCredential().Password) { throw 'MACHINE_SECRET_EXISTS' }
            } else { [IO.File]::Copy($pendingFile, $target.File, $false) }
            return @{ok=$true;outcome='promoted'}
        }
        if ($InputData.expectedActorId -isnot [string] -or $InputData.expectedActorId -cnotmatch '^[0-9a-f]{32}$') { throw 'INPUT_INVALID' }
        $actor = Read-Onboarding $Identity @{resource='actor'}
        $adminRole = Read-Onboarding $Identity @{resource='roles';roleNames=@('admin')}
        $actorGrants = Read-Onboarding $Identity @{resource='grants';recordId=$InputData.expectedActorId}
        if ($actor.outcome -cne 'readable' -or $actor.truncated -or $actor.rows.Count -ne 1 -or $actor.rows[0].sys_id -cne $InputData.expectedActorId -or
            $actor.rows[0].user_name -cne $Identity.User -or -not (Test-SourceBoolean $actor.rows[0].active $true) -or -not (Test-SourceBoolean $actor.rows[0].web_service_access_only $false) -or
            $adminRole.outcome -cne 'readable' -or $adminRole.truncated -or $adminRole.rows.Count -ne 1 -or
            $actorGrants.outcome -cne 'readable' -or $actorGrants.truncated -or -not @($actorGrants.rows|Where-Object {$_.user -eq $InputData.expectedActorId -and $_.role -eq $adminRole.rows[0].sys_id}).Count) { return @{ok=$true;outcome='rejected';reason='admin_identity_unverified'} }
        $machine = Read-Onboarding $Identity @{resource='machine';targetUser=$InputData.targetUser}
        if ($machine.outcome -cne 'readable' -or $machine.truncated) { return @{ok=$true;outcome='rejected';reason='lookup_unverified'} }
        if ($isRole) {
            if ($machine.rows.Count -ne 1 -or $machine.rows[0].sys_id -cne $InputData.recordId -or $machine.rows[0].source -cne ('SN-DemoSeeder:'+$InputData.operationId)) { return @{ok=$true;outcome='rejected';reason='owned_identity_unverified'} }
            $roles = Read-Onboarding $Identity @{resource='roles';roleNames=@('itil','knowledge','knowledge_admin','itil_admin')}
            if ($roles.outcome -cne 'readable' -or $roles.truncated -or @($roles.rows|Where-Object {$_.sys_id -ceq $InputData.roleId}).Count -ne 1) { return @{ok=$true;outcome='rejected';reason='role_unverified'} }
            $grants = Read-Onboarding $Identity @{resource='grants';recordId=$InputData.recordId}
            if ($grants.outcome -cne 'readable' -or $grants.truncated -or @($grants.rows|Where-Object {$_.role -eq $InputData.roleId}).Count) { return @{ok=$true;outcome='rejected';reason='role_lookup_changed'} }
        } else {
            if ($machine.rows.Count) { return @{ok=$true;outcome='rejected';reason='username_collision'} }
            $dictionary = Read-Onboarding $Identity @{resource='dictionary'}
            if ($dictionary.outcome -cne 'readable' -or $dictionary.truncated -or @($dictionary.rows|Where-Object {$_.element -ceq 'user_name' -and (Test-SourceBoolean $_.unique $true)}).Count -ne 1) { return @{ok=$true;outcome='rejected';reason='uniqueness_unverified'} }
            $choices = Read-Onboarding $Identity @{resource='choices'}
            if ($choices.outcome -cne 'readable' -or $choices.truncated -or @($choices.rows|Where-Object {$_.label -ceq 'Machine' -and $_.value -ceq $InputData.machineChoice -and (Test-SourceBoolean $_.inactive $false)}).Count -ne 1) { return @{ok=$true;outcome='rejected';reason='machine_choice_changed'} }
            $payload.user_password = $secretEnvelope.Credential.GetNetworkCredential().Password
        }
        return (Send-MachinePost $Identity $url $payload $fields)
    } finally {
        if ($null -ne $secretEnvelope) { $secretEnvelope.Credential.Password.Dispose() }
        if ($null -ne $existingEnvelope) { $existingEnvelope.Credential.Password.Dispose() }
        if ($payload.ContainsKey('user_password')) { $payload.user_password = $null }
    }
}
function Send-MachinePost($Identity, [string]$Url, [hashtable]$Payload, [string]$Fields, [ValidateSet('POST','PATCH')][string]$Method='POST') {
    if (-not [IO.File]::Exists($Identity.File)) { return @{ok=$true;outcome='rejected';reason='admin_credential_missing'} }
    $envelope = Import-Clixml -LiteralPath $Identity.File
    if (-not (Identity-Matches $envelope $Identity)) { $envelope.Credential.Password.Dispose(); return @{ok=$true;outcome='rejected';reason='admin_credential_mismatch'} }
    $handler = [Net.Http.HttpClientHandler]::new(); $handler.AllowAutoRedirect = $false; $handler.UseCookies = $false
    $client = [Net.Http.HttpClient]::new($handler); $client.Timeout = [TimeSpan]::FromSeconds(25)
    $request = [Net.Http.HttpRequestMessage]::new($(if($Method -ceq 'PATCH'){[Net.Http.HttpMethod]::Patch}else{[Net.Http.HttpMethod]::Post}), $Url); $response = $null; $stream = $null; $bytes = $null
    $deadline = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds(25))
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($Identity.User + ':' + $envelope.Credential.GetNetworkCredential().Password)
        $request.Headers.Authorization = [Net.Http.Headers.AuthenticationHeaderValue]::new('Basic',[Convert]::ToBase64String($bytes))
        [Array]::Clear($bytes,0,$bytes.Length); $bytes = $null
        $request.Headers.Accept.ParseAdd('application/json')
        $request.Content = [Net.Http.StringContent]::new(($Payload|ConvertTo-Json -Compress),[Text.Encoding]::UTF8,'application/json')
        $response = $client.SendAsync($request,[Net.Http.HttpCompletionOption]::ResponseHeadersRead,$deadline.Token).GetAwaiter().GetResult()
        if ([int]$response.StatusCode -in @(401,403)) { return @{ok=$true;outcome='rejected';reason='write_denied'} }
        if ([int]$response.StatusCode -ne $(if($Method -ceq 'PATCH'){200}else{201})) { return @{ok=$true;outcome='uncertain'} }
        $stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult(); $memory = [IO.MemoryStream]::new()
        try {
            $buffer = [byte[]]::new(4096)
            while (($count=$stream.ReadAsync($buffer,0,$buffer.Length,$deadline.Token).GetAwaiter().GetResult()) -gt 0) {
                if ($memory.Length+$count -gt 1048576) { return @{ok=$true;outcome='uncertain'} }; $memory.Write($buffer,0,$count)
            }
            try { $body=[Text.Encoding]::UTF8.GetString($memory.ToArray())|ConvertFrom-Json -AsHashtable } catch { return @{ok=$true;outcome='uncertain'} }
            if ($body -isnot [hashtable] -or -not $body.ContainsKey('result') -or $body.result -isnot [hashtable]) { return @{ok=$true;outcome='uncertain'} }
            $row=@{}; foreach($field in $Fields.Split(',')){if($body.result.ContainsKey($field)){$row[$field]=$body.result[$field]}}
            return @{ok=$true;outcome='created';row=$row}
        } finally { $memory.Dispose() }
    } catch {
        $cause=$_.Exception; while($null -ne $cause.InnerException){$cause=$cause.InnerException}
        if($cause -is [Net.Http.HttpRequestException] -or $cause -is [IO.IOException] -or $cause -is [OperationCanceledException]){return @{ok=$true;outcome='uncertain'}}
        throw 'HELPER_FAILED'
    } finally {
        if($null -ne $bytes){[Array]::Clear($bytes,0,$bytes.Length)}
        if($null -ne $stream){$stream.Dispose()}; if($null -ne $response){$response.Dispose()}
        $request.Dispose(); $client.Dispose(); $deadline.Dispose(); $envelope.Credential.Password.Dispose()
    }
}

function Person-Operation($Identity, $InputData) {
    if ($Identity.Purpose -cne 'integration' -or $InputData.operationId -isnot [string] -or $InputData.operationId -cnotmatch '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' -or $InputData.recordId -cne $InputData.operationId.Replace('-','') -or
        $InputData.targetUser -isnot [string] -or $InputData.targetUser -cnotmatch '^[A-Za-z0-9_.@+-]{1,120}$' -or $InputData.targetUser -ieq $Identity.User -or
        $InputData.email -isnot [string] -or $InputData.email.Length -gt 254 -or $InputData.email -cnotmatch '^[a-z0-9._%+-]+@[a-z0-9.-]+$' -or
        $InputData.humanChoice -isnot [string] -or $InputData.humanChoice -cnotmatch '^[A-Za-z0-9_-]{1,80}$') { throw 'INPUT_INVALID' }
    foreach($name in @('firstName','lastName')){if($InputData[$name] -isnot [string] -or [string]::IsNullOrWhiteSpace($InputData[$name]) -or $InputData[$name].Length -gt 160 -or $InputData[$name] -match '[\x00-\x1f\x7f]'){throw 'INPUT_INVALID'}}
    $roleWrite=$Action -ceq 'CreatePersonRole' -or ($Action -ceq 'DescribePersonWrite' -and $InputData.ContainsKey('roleId'))
    if($roleWrite -and ($InputData.roleName -cnotin @('itil','knowledge','knowledge_admin','admin') -or $InputData.roleId -isnot [string] -or $InputData.roleId -cnotmatch '^[0-9a-f]{32}$' -or $InputData.grantId -isnot [string] -or $InputData.grantId -cnotmatch '^[0-9a-f]{32}$')){throw 'INPUT_INVALID'}
    $payload=if($roleWrite){@{sys_id=$InputData.grantId;user=$InputData.recordId;role=$InputData.roleId}}else{@{sys_id=$InputData.recordId;user_name=$InputData.targetUser;email=$InputData.email;first_name=$InputData.firstName;last_name=$InputData.lastName;active=$true;identity_type=$InputData.humanChoice;web_service_access_only=$false;source=('SN-DemoSeeder:'+$InputData.operationId)}}
    $fields=if($roleWrite){'sys_id,user,role'}else{'sys_id,user_name,email,first_name,last_name,active,identity_type,web_service_access_only,source'}
    $table=if($roleWrite){'sys_user_has_role'}else{'sys_user'}
    $url=$Identity.InstanceUrl+'/api/now/table/'+$table+'?sysparm_display_value=false&sysparm_exclude_reference_link=true&sysparm_fields='+[Uri]::EscapeDataString($fields)
    if($Action -ceq 'DescribePersonWrite'){return @{ok=$true;method='POST';url=$url;fields=$payload;passwordHandling='no-password-set-or-copied'}}
    if($InputData.expectedActorId -isnot [string] -or $InputData.expectedActorId -cnotmatch '^[0-9a-f]{32}$' -or $InputData.machineChoice -isnot [string]){throw 'INPUT_INVALID'}
    $actor=Read-Onboarding $Identity @{resource='actor'};$roles=Read-Onboarding $Identity @{resource='roles';roleNames=@('admin','itil','knowledge','knowledge_admin')};$grants=Read-Onboarding $Identity @{resource='grants';recordId=$InputData.expectedActorId}
    $admin=@($roles.rows|Where-Object {$_.name -ceq 'admin'})
    if($actor.outcome -cne 'readable' -or $actor.truncated -or $actor.rows.Count -ne 1 -or $actor.rows[0].sys_id -cne $InputData.expectedActorId -or $actor.rows[0].user_name -cne $Identity.User -or -not (Test-SourceBoolean $actor.rows[0].active $true) -or -not (Test-SourceBoolean $actor.rows[0].web_service_access_only $true) -or $actor.rows[0].identity_type -cne $InputData.machineChoice -or
        $roles.outcome -cne 'readable' -or $roles.truncated -or $admin.Count -ne 1 -or $grants.outcome -cne 'readable' -or $grants.truncated -or -not @($grants.rows|Where-Object {$_.user -ceq $InputData.expectedActorId -and $_.role -ceq $admin[0].sys_id}).Count){return @{ok=$true;outcome='rejected';reason='machine_admin_unverified'}}
    $choices=Read-Onboarding $Identity @{resource='choices'}
    if($choices.outcome -cne 'readable' -or $choices.truncated -or @($choices.rows|Where-Object {$_.label -ceq 'Human' -and $_.value -ceq $InputData.humanChoice -and (Test-SourceBoolean $_.inactive $false)}).Count -ne 1){return @{ok=$true;outcome='rejected';reason='human_choice_unverified'}}
    $person=Read-Onboarding $Identity @{resource='person';targetUser=$InputData.targetUser;email=$InputData.email}
    if($person.outcome -cne 'readable' -or $person.truncated){return @{ok=$true;outcome='rejected';reason='person_lookup_unverified'}}
    if($roleWrite){
        $match=$person.rows
        if($match.Count -ne 1 -or $match[0].sys_id -cne $InputData.recordId -or $match[0].source -cne ('SN-DemoSeeder:'+$InputData.operationId) -or $match[0].email -ine $InputData.email -or $match[0].user_name -cne $InputData.targetUser -or -not (Test-SourceBoolean $match[0].active $true) -or $match[0].identity_type -cne $InputData.humanChoice -or -not (Test-SourceBoolean $match[0].web_service_access_only $false)){return @{ok=$true;outcome='rejected';reason='owned_person_unverified'}}
        if(@($roles.rows|Where-Object {$_.name -ceq $InputData.roleName -and $_.sys_id -ceq $InputData.roleId}).Count -ne 1){return @{ok=$true;outcome='rejected';reason='exact_role_unverified'}}
        $existing=Read-Onboarding $Identity @{resource='grants';recordId=$InputData.recordId}
        if($existing.outcome -cne 'readable' -or $existing.truncated -or @($existing.rows|Where-Object {$_.role -ceq $InputData.roleId}).Count){return @{ok=$true;outcome='rejected';reason='grant_lookup_changed'}}
    }else{
        if($person.rows.Count){return @{ok=$true;outcome='rejected';reason='email_or_login_collision'}}
        $schema=Read-Onboarding $Identity @{resource='peopleDictionary'}
        if($schema.outcome -cne 'readable' -or $schema.truncated -or @($schema.rows|Where-Object {$_.element -ceq 'user_name' -and (Test-SourceBoolean $_.unique $true)}).Count -ne 1){return @{ok=$true;outcome='rejected';reason='uniqueness_unverified'}}
        foreach($key in @('user_name','email','first_name','last_name','source','active','identity_type','web_service_access_only')){if(@($schema.rows|Where-Object {$_.element -ceq $key -and (Test-SourceBoolean $_.read_only $false)}).Count -ne 1){return @{ok=$true;outcome='rejected';reason='schema_changed'}}}
    }
    return (Send-MachinePost $Identity $url $payload $fields)
}

function Test-HumanPassword($Identity,$InputData) {
    $handler=[Net.Http.HttpClientHandler]::new();$handler.AllowAutoRedirect=$false;$handler.UseCookies=$false
    $client=[Net.Http.HttpClient]::new($handler);$client.Timeout=[TimeSpan]::FromSeconds(25)
    $url=$Identity.InstanceUrl+'/api/now/table/sys_user?sysparm_limit=2&sysparm_fields=sys_id,user_name&sysparm_query='+[Uri]::EscapeDataString('sys_id='+$InputData.recordId+'^user_name='+$InputData.targetUser)
    $request=[Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Get,$url);$response=$null;$stream=$null;$bytes=$null
    $deadline=[Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds(25))
    try{
        $bytes=[Text.Encoding]::UTF8.GetBytes($InputData.targetUser+':'+$InputData.password)
        $request.Headers.Authorization=[Net.Http.Headers.AuthenticationHeaderValue]::new('Basic',[Convert]::ToBase64String($bytes));[Array]::Clear($bytes,0,$bytes.Length);$bytes=$null
        $request.Headers.Accept.ParseAdd('application/json')
        $response=$client.SendAsync($request,[Net.Http.HttpCompletionOption]::ResponseHeadersRead,$deadline.Token).GetAwaiter().GetResult()
        if([int]$response.StatusCode -ne 200){return $false}
        $stream=$response.Content.ReadAsStreamAsync().GetAwaiter().GetResult();$memory=[IO.MemoryStream]::new()
        try{
            $buffer=[byte[]]::new(4096)
            while(($count=$stream.ReadAsync($buffer,0,$buffer.Length,$deadline.Token).GetAwaiter().GetResult()) -gt 0){if($memory.Length+$count -gt 262144){return $false};$memory.Write($buffer,0,$count)}
            try{$body=[Text.Encoding]::UTF8.GetString($memory.ToArray())|ConvertFrom-Json -AsHashtable}catch{return $false}
            return $body -is [hashtable] -and $body.ContainsKey('result') -and $body.result -is [array] -and $body.result.Count -eq 1 -and $body.result[0].sys_id -ceq $InputData.recordId -and $body.result[0].user_name -ceq $InputData.targetUser
        }finally{$memory.Dispose()}
    }catch{
        $cause=$_.Exception;while($null -ne $cause.InnerException){$cause=$cause.InnerException}
        if($cause -is [Net.Http.HttpRequestException] -or $cause -is [IO.IOException] -or $cause -is [OperationCanceledException]){return $false};throw 'HELPER_FAILED'
    }finally{if($null -ne $bytes){[Array]::Clear($bytes,0,$bytes.Length)};if($null -ne $stream){$stream.Dispose()};if($null -ne $response){$response.Dispose()};$request.Dispose();$client.Dispose();$deadline.Dispose()}
}
function Person-Password($Identity,$InputData){
    if($Identity.Purpose -cne 'integration' -or $InputData.recordId -isnot [string] -or $InputData.recordId -cnotmatch '^[0-9a-f]{32}$' -or $InputData.expectedActorId -isnot [string] -or $InputData.expectedActorId -cnotmatch '^[0-9a-f]{32}$' -or $InputData.recordId -ceq $InputData.expectedActorId -or
        $InputData.targetUser -isnot [string] -or $InputData.targetUser -cnotmatch '^[A-Za-z0-9_.@+-]{1,120}$' -or $InputData.targetUser -ieq $Identity.User -or $InputData.email -isnot [string] -or $InputData.email -cnotmatch '^[a-z0-9._%+-]+@[a-z0-9.-]+$' -or
        $InputData.humanChoice -isnot [string] -or $InputData.humanChoice -cnotmatch '^[A-Za-z0-9_-]{1,80}$' -or $InputData.machineChoice -isnot [string]){throw 'INPUT_INVALID'}
    $url=$Identity.InstanceUrl+'/api/now/table/sys_user/'+$InputData.recordId+'?sysparm_display_value=false&sysparm_exclude_reference_link=true&sysparm_fields=sys_id,user_name'
    if($Action -ceq 'DescribePersonPassword'){return @{ok=$true;method='PATCH';url=$url;fields=@('user_password','password_needs_reset');passwordHandling='stdin-only-no-persistence-or-output';targetUser=$InputData.targetUser}}
    if($InputData.password -isnot [string] -or $InputData.password.Length -lt 1 -or $InputData.password.Length -gt 4096 -or $InputData.password.Contains([char]0)){throw 'INPUT_INVALID'}
    $accepted=$false;$payload=$null
    try{
        $actor=Read-Onboarding $Identity @{resource='actor'};$roles=Read-Onboarding $Identity @{resource='roles';roleNames=@('admin')};$grants=Read-Onboarding $Identity @{resource='grants';recordId=$InputData.expectedActorId}
        if($actor.outcome -cne 'readable' -or $actor.truncated -or $actor.rows.Count -ne 1 -or $actor.rows[0].sys_id -cne $InputData.expectedActorId -or $actor.rows[0].user_name -cne $Identity.User -or -not(Test-SourceBoolean $actor.rows[0].active $true) -or -not(Test-SourceBoolean $actor.rows[0].web_service_access_only $true) -or $actor.rows[0].identity_type -cne $InputData.machineChoice -or
            $roles.outcome -cne 'readable' -or $roles.truncated -or $roles.rows.Count -ne 1 -or $grants.outcome -cne 'readable' -or $grants.truncated -or -not @($grants.rows|Where-Object {$_.user -ceq $InputData.expectedActorId -and $_.role -ceq $roles.rows[0].sys_id}).Count){return @{ok=$true;outcome='rejected';updateAccepted=$false;authentication='not-verified'}}
        $person=Read-Onboarding $Identity @{resource='person';targetUser=$InputData.targetUser;email=$InputData.email}
        if($person.outcome -cne 'readable' -or $person.truncated -or $person.rows.Count -ne 1 -or $person.rows[0].sys_id -cne $InputData.recordId -or $person.rows[0].user_name -cne $InputData.targetUser -or $person.rows[0].email -ine $InputData.email -or $person.rows[0].identity_type -cne $InputData.humanChoice -or -not(Test-SourceBoolean $person.rows[0].active $true) -or -not(Test-SourceBoolean $person.rows[0].web_service_access_only $false)){return @{ok=$true;outcome='rejected';updateAccepted=$false;authentication='not-verified'}}
        if($Action -cne 'VerifyPersonPassword'){
            $schema=Read-Onboarding $Identity @{resource='passwordDictionary'}
            if($schema.outcome -cne 'readable' -or $schema.truncated){return @{ok=$true;outcome='rejected';updateAccepted=$false;authentication='not-verified'}}
            $passwordField=@($schema.rows|Where-Object {$_.element -ceq 'user_password' -and $_.internal_type -cin @('password','password2') -and (Test-SourceBoolean $_.read_only $false) -and $_.max_length -match '^\d+$' -and [int]$_.max_length -ge $InputData.password.Length})
            $resetField=@($schema.rows|Where-Object {$_.element -ceq 'password_needs_reset' -and $_.internal_type -ceq 'boolean' -and (Test-SourceBoolean $_.read_only $false)})
            if($passwordField.Count -ne 1 -or $resetField.Count -ne 1){return @{ok=$true;outcome='rejected';updateAccepted=$false;authentication='not-verified'}}
            $payload=@{user_password=$InputData.password;password_needs_reset=$false}
            $result=Send-MachinePost $Identity $url $payload 'sys_id,user_name' -Method PATCH
            if($result.outcome -cne 'created' -or $result.row.sys_id -cne $InputData.recordId -or $result.row.user_name -cne $InputData.targetUser){return @{ok=$true;outcome=$(if($result.outcome -ceq 'rejected'){'rejected'}else{'uncertain'});updateAccepted=$false;authentication='not-verified'}}
            $accepted=$true
        }
        $verified=Test-HumanPassword $Identity $InputData
        return @{ok=$true;outcome=$(if($verified){'verified'}elseif($accepted){'applied'}else{'uncertain'});updateAccepted=$accepted;authentication=$(if($verified){'authenticated'}else{'not-verified'})}
    }finally{$InputData.password=$null;if($null -ne $payload){$payload.user_password=$null}}
}

function Content-Operation($Identity,$InputData){
    if($Identity.Purpose -cne 'integration' -or $InputData.table -cnotin @('incident','kb_knowledge') -or $InputData.operationId -isnot [string] -or $InputData.operationId -cnotmatch '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' -or $InputData.payload -isnot [hashtable]){throw 'INPUT_INVALID'}
    $payload=$InputData.payload;$table=$InputData.table
    $required=if($table -ceq 'incident'){@('sys_id','short_description','description','caller_id','correlation_id')}else{@('sys_id','short_description','text','author','kb_knowledge_base','workflow_state','active')}
    $allowed=if($table -ceq 'incident'){@('sys_id','short_description','description','caller_id','category','impact','urgency','correlation_id')}elseif($Action -cin @('CreateKnowledgePack','DescribeKnowledgePackWrite')){@($required)+@('kb_category')}else{$required}
    if($payload.sys_id -cne $InputData.operationId.Replace('-','') -or @($payload.Keys|Where-Object {$_ -cnotin $allowed}).Count -or @($required|Where-Object {-not $payload.ContainsKey($_)}).Count){throw 'INPUT_INVALID'}
    foreach($key in @('short_description',$(if($table -ceq 'incident'){'description'}else{'text'}))){if($payload[$key] -isnot [string] -or [string]::IsNullOrWhiteSpace($payload[$key]) -or $payload[$key] -match '[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]' -or $payload[$key] -match '(?i)\b(demo|synthetic|fictional|fake|sample[ -]?data|test[ -]?data)\b'){throw 'INPUT_INVALID'}}
    if($payload.short_description.Length -gt 160 -or $payload.short_description.Contains('^')){throw 'INPUT_INVALID'}
    if($table -ceq 'incident'){
        if($payload.caller_id -isnot [string] -or $payload.caller_id -cnotmatch '^[0-9a-f]{32}$' -or $payload.correlation_id -cne ('SNDS:'+$InputData.operationId) -or $payload.description.Length -gt 4000){throw 'INPUT_INVALID'}
    }else{
        if(-not $InputData.ContainsKey('workflowLabel') -or $InputData.workflowLabel -isnot [string] -or $InputData.workflowLabel -cnotin @('Draft','Published')){throw 'INPUT_INVALID'}
        if($payload.author -isnot [string] -or $payload.author -cnotmatch '^[0-9a-f]{32}$' -or $payload.kb_knowledge_base -isnot [string] -or $payload.kb_knowledge_base -cnotmatch '^[0-9a-f]{32}$' -or $payload.workflow_state -isnot [string] -or -not(Test-SourceBoolean $payload.active $true) -or $payload.short_description.Length -gt 100 -or $payload.text.Length -gt 65000){throw 'INPUT_INVALID'}
        if($payload.text -match '<(?!/?(?:h[1-6]|p|ul|ol|li|strong|em|br|blockquote|code|pre)\s*/?>)' -or $payload.text -match '(?i)javascript:'){throw 'INPUT_INVALID'}
    }
    if($table -ceq 'incident' -and $InputData.ContainsKey('workflowLabel')){throw 'INPUT_INVALID'}
    $fields=if($table -ceq 'incident'){'sys_id,number,short_description,description,caller_id,assigned_to,assignment_group,category,impact,urgency,state,correlation_id,sys_created_by,sys_mod_count'}else{'sys_id,number,short_description,text,author,kb_knowledge_base,kb_category,workflow_state,active,sys_created_by,sys_mod_count'}
    $url=$Identity.InstanceUrl+'/api/now/table/'+$table+'?sysparm_display_value=false&sysparm_exclude_reference_link=true&sysparm_fields='+[Uri]::EscapeDataString($fields)
    if($Action -cin @('DescribeContentWrite','DescribeKnowledgePackWrite')){
        $publication='not-applicable'
        if($table -ceq 'kb_knowledge'){
            $publication=if($InputData.workflowLabel -ceq 'Published'){'Knowledge create requests publication immediately when the approved workflow state supports Published.'}else{'Knowledge create requests a Draft article only.'}
        }
        return @{ok=$true;method='POST';url=$url;fields=$payload;publication=$publication}
    }
    if($InputData.expectedActorId -isnot [string] -or $InputData.expectedActorId -cnotmatch '^[0-9a-f]{32}$' -or $InputData.machineChoice -isnot [string] -or $InputData.humanChoice -isnot [string] -or $InputData.person -isnot [hashtable]){throw 'INPUT_INVALID'}
    $person=$InputData.person
    if($person.sysId -isnot [string] -or $person.sysId -cnotmatch '^[0-9a-f]{32}$' -or $person.userName -isnot [string] -or $person.email -isnot [string]){throw 'INPUT_INVALID'}
    $reference=if($table -ceq 'incident'){$payload.caller_id}else{$payload.author};if($reference -cne $person.sysId){throw 'INPUT_INVALID'}
    $actor=Read-Onboarding $Identity @{resource='actor'};$roles=Read-Onboarding $Identity @{resource='roles';roleNames=@('admin','knowledge','knowledge_admin')};$grants=Read-Onboarding $Identity @{resource='grants';recordId=$InputData.expectedActorId};$admin=@($roles.rows|Where-Object {$_.name -ceq 'admin'})
    if($actor.outcome -cne 'readable' -or $actor.truncated -or $actor.rows.Count -ne 1 -or $actor.rows[0].sys_id -cne $InputData.expectedActorId -or $actor.rows[0].user_name -cne $Identity.User -or -not(Test-SourceBoolean $actor.rows[0].active $true) -or -not(Test-SourceBoolean $actor.rows[0].web_service_access_only $true) -or $actor.rows[0].identity_type -cne $InputData.machineChoice -or $roles.outcome -cne 'readable' -or $roles.truncated -or $admin.Count -ne 1 -or $grants.outcome -cne 'readable' -or $grants.truncated -or -not @($grants.rows|Where-Object {$_.user -ceq $InputData.expectedActorId -and $_.role -ceq $admin[0].sys_id}).Count){return @{ok=$true;outcome='rejected'}}
    $people=Read-Onboarding $Identity @{resource='person';targetUser=$person.userName;email=$person.email}
    if($people.outcome -cne 'readable' -or $people.truncated -or $people.rows.Count -ne 1 -or $people.rows[0].sys_id -cne $person.sysId -or $people.rows[0].user_name -cne $person.userName -or $people.rows[0].email -ine $person.email -or -not(Test-SourceBoolean $people.rows[0].active $true) -or -not(Test-SourceBoolean $people.rows[0].web_service_access_only $false) -or $people.rows[0].identity_type -cne $InputData.humanChoice){return @{ok=$true;outcome='rejected'}}
    if($table -ceq 'kb_knowledge'){
        if($person.roleName -cnotin @('knowledge','knowledge_admin') -or $person.roleId -isnot [string] -or $person.roleId -cnotmatch '^[0-9a-f]{32}$'){throw 'INPUT_INVALID'}
        $authorGrants=Read-Onboarding $Identity @{resource='grants';recordId=$person.sysId}
        if($authorGrants.outcome -cne 'readable' -or $authorGrants.truncated -or @($roles.rows|Where-Object {$_.name -ceq $person.roleName -and $_.sys_id -ceq $person.roleId}).Count -ne 1 -or -not @($authorGrants.rows|Where-Object {$_.user -ceq $person.sysId -and $_.role -ceq $person.roleId}).Count){return @{ok=$true;outcome='rejected'}}
        $bases=Read-Onboarding $Identity @{resource='knowledgeBases'}
        if($bases.outcome -cne 'readable' -or $bases.truncated -or @($bases.rows|Where-Object {$_.sys_id -ceq $payload.kb_knowledge_base -and (Test-SourceBoolean $_.active $true)}).Count -ne 1){return @{ok=$true;outcome='rejected'}}
    }
    $dictionary=Read-Onboarding $Identity @{resource='contentDictionary'};$choices=Read-Onboarding $Identity @{resource='contentChoices'}
    if($dictionary.outcome -cne 'readable' -or $dictionary.truncated -or $choices.outcome -cne 'readable' -or $choices.truncated){return @{ok=$true;outcome='rejected'}}
    foreach($key in @($payload.Keys|Where-Object {$_ -cne 'sys_id'})){
        $meta=@($dictionary.rows|Where-Object {$_.name -ceq $table -and $_.element -ceq $key})
        if($meta.Count -eq 0 -and $table -ceq 'incident'){$meta=@($dictionary.rows|Where-Object {$_.name -ceq 'task' -and $_.element -ceq $key})}
        if($meta.Count -ne 1 -or -not(Test-SourceBoolean $meta[0].read_only $false) -or ($payload[$key] -is [string] -and ($meta[0].max_length -notmatch '^\d+$' -or $payload[$key].Length -gt [int]$meta[0].max_length))){return @{ok=$true;outcome='rejected'}}
    }
    if($table -ceq 'incident'){
        foreach($key in @('category','impact','urgency')){if($payload.ContainsKey($key)){$matches=@($choices.rows|Where-Object {$_.name -ceq 'incident' -and $_.element -ceq $key -and $_.value -ceq $payload[$key]});if($matches.Count -eq 0){$matches=@($choices.rows|Where-Object {$_.name -ceq 'task' -and $_.element -ceq $key -and $_.value -ceq $payload[$key]})};if($matches.Count -ne 1){return @{ok=$true;outcome='rejected'}}}}
    }elseif(@($choices.rows|Where-Object {$_.name -ceq 'kb_knowledge' -and $_.element -ceq 'workflow_state' -and $_.label -ceq $InputData.workflowLabel -and $_.value -ceq $payload.workflow_state}).Count -ne 1){return @{ok=$true;outcome='rejected'}}
    $options=@{resource='contentLookup';table=$table;recordId=$payload.sys_id;title=$payload.short_description};if($table -ceq 'incident'){$options.marker=$payload.correlation_id}else{$options.baseId=$payload.kb_knowledge_base}
    $existing=Read-Onboarding $Identity $options
    if($existing.outcome -cne 'readable' -or $existing.truncated -or $existing.rows.Count){return @{ok=$true;outcome='rejected'}}
    return (Send-MachinePost $Identity $url $payload $fields)
}

try {
    if (-not $IsWindows) { throw 'WINDOWS_REQUIRED' }
    $inputData = Read-BoundedInput
    $identity = Validate-Input $inputData
    if ($Action -ceq 'Capture') { Send-Result (Capture-Credential $identity) }
    elseif ($Action -ceq 'Save') { try { Send-Result (Save-Credential $identity $inputData.password) } finally { $inputData.password = $null } }
    elseif ($Action -ceq 'BrowserLogin') { Send-Result (Browser-Login $identity $inputData) }
    elseif ($Action -cin @('PrepareMachineSecret','CreateMachine','CreateMachineRole','PromoteMachineSecret','DescribeMachineWrite')) { Send-Result (Machine-Operation $identity $inputData) }
    elseif ($Action -cin @('CreatePerson','CreatePersonRole','DescribePersonWrite')) { Send-Result (Person-Operation $identity $inputData) }
    elseif ($Action -cin @('SetPersonPassword','VerifyPersonPassword','DescribePersonPassword')) { Send-Result (Person-Password $identity $inputData) }
    elseif ($Action -cin @('CreateContent','DescribeContentWrite')) { Send-Result (Content-Operation $identity $inputData) }
    elseif ($Action -cin @('CreateKnowledgePack','DescribeKnowledgePackWrite')) { Send-Result (KnowledgePack-Operation $identity $inputData) }
    elseif ($Action -cin @('ReadOnboarding','ReadBootstrap','DescribeOnboarding')) { Send-Result (Read-Onboarding $identity $inputData) }
    else { Send-Result (Test-Credential $identity) }
} catch {
    $code = 'HELPER_FAILED'
    foreach ($allowed in @('WINDOWS_REQUIRED', 'INTERACTIVE_REQUIRED', 'INPUT_INVALID', 'CREDENTIAL_SAVE_FAILED', 'HELPER_PROTOCOL', 'TIMED_OUT', 'MACHINE_SECRET_EXISTS', 'MACHINE_SECRET_MISSING')) {
        if ($_.Exception.Message -ceq $allowed) { $code = $allowed; break }
    }
    Send-Result @{ ok = $false; code = $code }
    exit 1
}
