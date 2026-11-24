# All inputs are disposable, offline files. Run normally for user-mode tests.
# -DisposableMachine additionally requires an elevated disposable Windows VM
# with no existing test-product cache; never touches the production cache.
param([switch]$DisposableMachine,[string]$PublicConfig)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::Combine([IO.Path]::GetTempPath(),'ms-native-' + [Guid]::NewGuid().ToString('N'))
$old = "$root\old app"; $store = "$root\custom store"; $rel = 'assets\onnx\transkun_v2_config.json'
$src = "$old\$rel"; $dst = "$store\native\$rel"; $cache = $null
$worker = "$PSScriptRoot\preserve-native.ps1"; $protected = "$PSScriptRoot\shared-medley.ps1"
$admin = ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
function Digest([IO.Stream]$f) { $s=[Security.Cryptography.SHA256]::Create(); try { [BitConverter]::ToString($s.ComputeHash($f)).Replace('-','') } finally { $s.Dispose() } }
function Write-File([string]$path,[byte[]]$bytes) { [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path)); [IO.File]::WriteAllBytes($path,$bytes) }
function Assert([bool]$ok,[string]$msg) { if (!$ok) { throw $msg } }
function Migrate([string]$to = $store) { & $worker -InstallRoots @($old,$old) -StorageDir $to -ManifestBytes $manifest }
function Refuses([scriptblock]$action,[string]$message) {
    try { & $action } catch { if ($_.Exception.Message -notlike "*$message*") { throw }; return }
    throw "Expected migration to refuse: $message"
}
$save = @{}
foreach ($n in 'OPERATION','PRODUCT','SHARED_SCRIPT','TARGET','TAURI','ELECTRON','WIX','STORAGE','OLD_STORAGE') {
    $key = 'MS_MEDLEY_' + $n; $save[$key] = [Environment]::GetEnvironmentVariable($key); [Environment]::SetEnvironmentVariable($key,$null)
}
try {
    if ($PublicConfig) {
        # Optional real 3.1.4 file; test against release pins, not a self-signed fixture.
        $bytes = [IO.File]::ReadAllBytes([IO.Path]::GetFullPath($PublicConfig))
        $manifest = [IO.File]::ReadAllBytes([IO.Path]::GetFullPath("$PSScriptRoot\..\..\tools\forge-components.json"))
        $hash = '988baf3596887d36c33b1ff9851911e5a536fbd575d3d07eedeba1002f6c3556'
    } else {
        $bytes = [Text.Encoding]::UTF8.GetBytes('disposable native component')
        $f = [IO.MemoryStream]::new($bytes,$false); try { $hash = Digest $f } finally { $f.Dispose() }
        $manifest = [Text.Encoding]::UTF8.GetBytes(('[{"group":"piano","path":"assets/onnx/transkun_v2_config.json","size":' + $bytes.Length + ',"sha256":"' + $hash + '"}]'))
    }
    [void][IO.Directory]::CreateDirectory($old)
    if ($admin) { Refuses { Migrate } 'elevated' } else {
        Migrate # fresh install performs no writes
        Assert (![IO.Directory]::Exists($store)) 'Fresh setup created a store.'
        Write-File $src $bytes; Migrate
        Assert ((Get-FileHash -LiteralPath $dst).Hash -eq $hash) 'Copy is not byte-exact.'
        $before = [IO.File]::GetLastWriteTimeUtc($dst); Migrate
        Assert ([IO.File]::GetLastWriteTimeUtc($dst) -eq $before) 'A retry replaced a verified file.'
        [IO.File]::WriteAllText($src,'unknown'); Refuses { Migrate } 'Unrecognized Forge file'
        Assert ([IO.File]::ReadAllText($src) -eq 'unknown') 'Changed a conflicting source.'
        Write-File $src $bytes; [IO.File]::WriteAllText($dst,'keep'); Refuses { Migrate } 'not overwritten'
        Assert ([IO.File]::ReadAllText($dst) -eq 'keep') 'Overwrote an existing file.'
        [IO.File]::Delete($dst); [IO.File]::Delete($src)
        $electron = "$old\resources\forge-rs\$rel"; Write-File $electron $bytes; Migrate
        Assert ((Get-FileHash -LiteralPath $dst).Hash -eq $hash) 'Missed nested Electron components.'
        $unknown = "$old\resources\python-engine\models\onnx\private.onnx"
        Write-File $unknown $bytes; Refuses { Migrate } 'move it outside'; [IO.File]::Delete($unknown)
        Refuses { Migrate "$old\unsafe" } 'outside the app folder'
        $link = "$root\junction"; $outside = "$root\outside"; [void][IO.Directory]::CreateDirectory($outside)
        $null = New-Item -ItemType Junction -Path $link -Target $outside
        try { Refuses { Migrate $link } 'link'; Assert (@([IO.Directory]::EnumerateFileSystemEntries($outside)).Count -eq 0) 'Wrote through junction.' } finally { [IO.Directory]::Delete($link) }
        [IO.Directory]::Delete($old,$true); Migrate
        Assert ((Get-FileHash -LiteralPath $dst).Hash -eq $hash) 'Public bytes did not survive removal of the old app.'
        Assert (@(Get-ChildItem $store -Recurse -Filter '*.partial').Count -eq 0) 'Leaked partial copy.'
    }
    if ($DisposableMachine) {
        Assert $admin 'Use an elevated disposable Windows VM for -DisposableMachine.'
        Assert (![string]::IsNullOrEmpty($PublicConfig)) 'Supply the real public transkun_v2_config.json with -PublicConfig.'
        $lm = [Microsoft.Win32.RegistryKey]::OpenBaseKey('LocalMachine','Registry64')
        try { $k=$lm.OpenSubKey('SOFTWARE\Microsoft\Windows\CurrentVersion'); try { $pf=$k.GetValue('ProgramFilesDir') } finally { $k.Dispose() } } finally { $lm.Dispose() }
        $testRoot = [IO.Path]::Combine($pf,'MIDI Studio Test Shared Models'); Assert (!(Test-Path -LiteralPath $testRoot)) 'Test-product cache already exists.'
        $cache = $testRoot
        Write-File $src $bytes
        [IO.File]::Copy($worker,"$root\preserve-native.ps1"); Write-File "$root\forge-components.json" $manifest
        $env:MS_MEDLEY_SHARED_SCRIPT = "$root\shared-medley.ps1"; $env:MS_MEDLEY_PRODUCT = 'MIDI Studio Test'; $env:MS_MEDLEY_TARGET = $old; $env:MS_MEDLEY_STORAGE = $store; $env:MS_MEDLEY_OPERATION='PreserveNative'
        $scriptPin = (Get-FileHash -LiteralPath $worker).Hash; $manifestPin=(Get-FileHash -LiteralPath "$root\forge-components.json").Hash
        function Gate([int]$want) { & $protected $scriptPin $manifestPin; Assert ($LASTEXITCODE -eq $want) "Expected protected result $want, got $LASTEXITCODE" }
        Gate 0; Gate 0
        Assert ((Get-FileHash -LiteralPath "$cache\native\$rel").Hash -eq $hash) 'Shared cache has wrong bytes.'
        Assert (![IO.Directory]::Exists($store)) 'Wrote to a user-selected path while elevated.'
        [IO.File]::AppendAllText("$root\forge-components.json",' '); Gate 26
        Write-File "$root\forge-components.json" $manifest; [IO.File]::AppendAllText("$root\preserve-native.ps1",' '); Gate 26
    }
    Write-Output 'Native component migration checks passed.'
} finally {
    if ($cache -and [IO.Directory]::Exists($cache)) { [IO.Directory]::Delete($cache,$true) }
    [IO.Directory]::Delete($root,$true)
    foreach ($key in $save.Keys) { [Environment]::SetEnvironmentVariable($key,$save[$key]) }
}
