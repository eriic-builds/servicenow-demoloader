param([Parameter(Mandatory)][ValidateSet('Login', 'Token')][string]$Action)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
$PSNativeCommandUseErrorActionPreference = $false

function Send-Result([hashtable]$Value) {
    [Console]::Out.WriteLine(($Value | ConvertTo-Json -Compress -Depth 6))
}
function Read-BoundedInput {
    $builder = [Text.StringBuilder]::new()
    $buffer = [char[]]::new(1024)
    while (($count = [Console]::In.Read($buffer, 0, $buffer.Length)) -gt 0) {
        if ($builder.Length + $count -gt 8192) { throw 'INPUT_INVALID' }
        [void]$builder.Append($buffer, 0, $count)
    }
    try { return ($builder.ToString() | ConvertFrom-Json -AsHashtable) } catch { throw 'INPUT_INVALID' }
}
function Validate-Input($InputData) {
    if ($InputData -isnot [hashtable] -or -not $InputData.ContainsKey('tenant') -or
        -not $InputData.ContainsKey('configDir') -or $InputData.tenant -isnot [string] -or $InputData.configDir -isnot [string]) { throw 'INPUT_INVALID' }
    if ($InputData.tenant -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' -and
        $InputData.tenant -cnotmatch '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.onmicrosoft\.com$') { throw 'INPUT_INVALID' }
    if ($InputData.configDir.Length -gt 2048 -or -not [IO.Path]::IsPathFullyQualified($InputData.configDir)) { throw 'INPUT_INVALID' }
    $config = [IO.Path]::GetFullPath($InputData.configDir)
    $aliasDirectory = [IO.Path]::GetDirectoryName($config)
    $tenantDirectory = [IO.Path]::GetDirectoryName($aliasDirectory)
    if ([IO.Path]::GetFileName($config) -cne 'azure-cli' -or
        [IO.Path]::GetFileName($aliasDirectory) -cnotmatch '^[0-9a-f]{64}$' -or
        [IO.Path]::GetFileName($tenantDirectory) -cne 'tenants') { throw 'INPUT_INVALID' }
    if ($Action -ceq 'Login') {
        $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($InputData.tenant))).ToLowerInvariant()
        if ([IO.Path]::GetFileName($aliasDirectory) -cne $hash) { throw 'INPUT_INVALID' }
    }
    return @{ Tenant = $InputData.tenant; Config = $config }
}
function Restrict-CacheDirectory([string]$Directory) {
    try {
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
    } catch [UnauthorizedAccessException] { throw 'CACHE_ACCESS' }
    catch [IO.IOException] { throw 'CACHE_ACCESS' }
    catch [Security.SecurityException] { throw 'CACHE_ACCESS' }
}
function Invoke-Azure($Command, [string[]]$Arguments) {
    $output = [Text.StringBuilder]::new()
    $lastDeviceCode = ''
    $prompt = ''
    # Only validated tenant literals and fixed switches reach the native argument array.
    # Even az.cmd dispatch has no caller-supplied shell command or command fragment.
    try { & $Command.Source @Arguments 2>&1 | ForEach-Object {
        $line = $_.ToString()
        $prompt = ($prompt + "`n" + $line)
        if ($prompt.Length -gt 8192) { $prompt = $prompt.Substring($prompt.Length - 8192) }
        if ($prompt -match 'https://microsoft\.com/devicelogin\b[\s\S]{0,240}?\bcode\s+([A-Z0-9]{6,20})\b') {
            $deviceCode = $Matches[1]
            if ($Action -ceq 'Login' -and $deviceCode -cne $lastDeviceCode) {
                [Console]::Error.WriteLine('To sign in, open https://microsoft.com/devicelogin and enter the code ' + $deviceCode)
                $lastDeviceCode = $deviceCode
            }
        }
        if ($_ -isnot [Management.Automation.ErrorRecord] -and $line -notmatch 'https://microsoft\.com/devicelogin|\bcode\s+[A-Z0-9]{6,20}\b') {
            if ($output.Length + $line.Length -gt 1048576) { throw 'HELPER_PROTOCOL' }
            [void]$output.AppendLine($line)
        }
        # All other native stderr is discarded, never reflected into a UI or error.
    } } catch {
        if ($_.Exception.Message -ceq 'HELPER_PROTOCOL') { throw 'HELPER_PROTOCOL' }
        throw 'CLI_START_FAILED'
    }
    return @{ ExitCode = $LASTEXITCODE; Text = $output.ToString() }
}

try {
    if (-not $IsWindows) { throw 'WINDOWS_REQUIRED' }
    $inputData = Validate-Input (Read-BoundedInput)
    $command = Get-Command -Name 'az.cmd', 'az' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $command) { throw 'CLI_MISSING' }
    Restrict-CacheDirectory $inputData.Config
    $env:AZURE_CONFIG_DIR = $inputData.Config
    $env:AZURE_CORE_COLLECT_TELEMETRY = 'no'
    $env:AZURE_CORE_NO_COLOR = 'true'
    $env:AZURE_CORE_ENABLE_BROKER_ON_WINDOWS = 'false'
    $env:AZURE_CORE_LOGIN_EXPERIENCE_V2 = 'off'
    if ($Action -ceq 'Login') {
        $arguments = @('login', '--tenant', $inputData.Tenant, '--use-device-code', '--allow-no-subscriptions', '--output', 'json')
        $result = Invoke-Azure $command $arguments
        if ($result.ExitCode -ne 0) { throw 'LOGIN_FAILED' }
        $knownTenant = $null
        try {
            $accounts = $result.Text | ConvertFrom-Json -AsHashtable
            $ids = @($accounts | ForEach-Object {
                if ($_ -is [hashtable] -and $_.ContainsKey('tenantId') -and
                    $_.tenantId -is [string] -and $_.tenantId -match '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') { $_.tenantId.ToLowerInvariant() }
            } | Select-Object -Unique)
            if ($ids.Count -eq 1) { $knownTenant = $ids[0] }
        } catch { throw 'LOGIN_FAILED' }
        Send-Result @{ ok = $true; tenantId = $knownTenant }
    } else {
        $arguments = @('account', 'get-access-token', '--tenant', $inputData.Tenant, '--resource', 'https://graph.microsoft.com', '--output', 'json', '--only-show-errors')
        $result = Invoke-Azure $command $arguments
        if ($result.ExitCode -ne 0) { throw 'TOKEN_FAILED' }
        try { $token = $result.Text | ConvertFrom-Json -AsHashtable } catch { throw 'TOKEN_FAILED' }
        if ($token -isnot [hashtable] -or -not $token.ContainsKey('accessToken') -or
            $token.accessToken -isnot [string] -or $token.accessToken.Length -gt 65536 -or
            $token.accessToken -cnotmatch '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$') { throw 'TOKEN_FAILED' }
        # Private pipe to Node only. The adapter never returns or logs this token.
        Send-Result @{ ok = $true; accessToken = $token.accessToken }
        $token = $null
    }
    $result = $null
} catch {
    $code = 'HELPER_FAILED'
    foreach ($allowed in @('WINDOWS_REQUIRED', 'CLI_MISSING', 'CACHE_ACCESS', 'CLI_START_FAILED', 'INPUT_INVALID', 'LOGIN_FAILED', 'TOKEN_FAILED', 'HELPER_PROTOCOL')) {
        if ($_.Exception.Message -ceq $allowed) { $code = $allowed; break }
    }
    Send-Result @{ ok = $false; code = $code }
    exit 1
}
