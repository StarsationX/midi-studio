# Default: read-only no-desktop policy against a never-registered fake tree.
# Optional: on a disposable Windows VM ONLY, use its REAL Program Files ACLs
# and the isolated test-product shared cache. No production cache is touched.
[CmdletBinding()]param([switch]$DisposableMachine,[string]$Onnx)
$ErrorActionPreference = 'Stop'
$scriptFile = Join-Path $PSScriptRoot 'shared-medley.ps1'
$root = Join-Path ([IO.Path]::GetTempPath()) ('ms-machine-upgrade-' + [Guid]::NewGuid().ToString('N'))
$old = "$root\electron"; $store = "$root\custom"; $graph = 'bsrofo_sw_body.onnx'; $ckpt='BS-Rofo-SW-Fixed.ckpt'
$pin = 'fa89f1997f7120f1eb3cac19e7590653d6e6b92ba9dd2d486645d86c0667aede'
$null=[IO.Directory]::CreateDirectory($old)
$variables = 'REGISTERED','PRODUCT','OPERATION','TARGET','TAURI','ELECTRON','WIX','OLD_VERSION','STORAGE','OLD_STORAGE','SHARED_INPUT'
$saved = @{}
foreach ($key in $variables) { $n='MS_MEDLEY_'+$key; $saved[$n]=[Environment]::GetEnvironmentVariable($n); [Environment]::SetEnvironmentVariable($n,$null) }
function Gate([int]$want) { & $scriptFile; if ($LASTEXITCODE -ne $want) { throw "Expected machine gate $want; got $LASTEXITCODE." } }
$removeTestCache = $false
try {
    $env:MS_MEDLEY_REGISTERED='none'; $env:MS_MEDLEY_PRODUCT=[IO.Path]::GetFileName($root)
    $env:MS_MEDLEY_OPERATION='CheckHeadlessTarget'; $env:MS_MEDLEY_TARGET=$old; $env:MS_MEDLEY_STORAGE=$store
    Gate 0 # true first install, empty target
    [IO.File]::WriteAllText("$old\MIDI Studio.exe",'marker only; never executed'); Gate 26 # unidentified portable
    [IO.File]::WriteAllText("$old\Uninstall MIDI Studio.exe",'marker only; never executed')
    $env:MS_MEDLEY_REGISTERED='electron'; $env:MS_MEDLEY_ELECTRON=$old; Gate 0
    $nested="$old\resources\forge-rs\assets\bs_rofo_sw"; $null=[IO.Directory]::CreateDirectory($nested)
    [IO.File]::WriteAllText("$nested\$graph",'unverified'); Gate 26
    [IO.File]::Delete("$nested\$graph"); [IO.File]::WriteAllText("$nested\$ckpt",'unverified'); Gate 26
    [IO.File]::Delete("$nested\$ckpt"); $custom="$store\models\bs_rofo_sw"; $null=[IO.Directory]::CreateDirectory($custom)
    [IO.File]::WriteAllText("$custom\$ckpt",'external checkpoint'); Gate 26
    [IO.File]::Delete("$custom\$ckpt"); $env:MS_MEDLEY_OLD_VERSION='3.1.0'; Gate 26
    Write-Output 'Headless machine preflight passed.'
    if ($DisposableMachine) {
        if (!$Onnx) { throw 'Supply the locally held verified ONNX using -Onnx on the disposable VM.' }
        $principal=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
        if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run the disposable-machine shared ACL checks as an administrator.' }
        $lm=[Microsoft.Win32.RegistryKey]::OpenBaseKey('LocalMachine','Registry64')
        try { $k=$lm.OpenSubKey('SOFTWARE\Microsoft\Windows\CurrentVersion'); try { $pf=$k.GetValue('ProgramFilesDir') } finally { $k.Dispose() } } finally { $lm.Dispose() }
        $cache=[IO.Path]::Combine($pf,'MIDI Studio Test Shared Models')
        if (Test-Path -LiteralPath $cache) { throw "Refusing to touch an existing test cache: $cache" }
        $env:MS_MEDLEY_OPERATION='PreserveShared'; $env:MS_MEDLEY_PRODUCT='MIDI Studio Test'
        $env:MS_MEDLEY_SHARED_INPUT="$nested\$graph"; [IO.File]::Copy($Onnx,$env:MS_MEDLEY_SHARED_INPUT)
        $removeTestCache=$true; Gate 0
        $dest="$cache\bs_rofo_sw\$graph"
        if ((Get-FileHash -LiteralPath $dest).Hash -ne $pin) { throw 'Shared cache has wrong bytes.' }
        [IO.File]::Delete($env:MS_MEDLEY_SHARED_INPUT); Gate 0 # survives disappearance of prior bundle
        [IO.File]::WriteAllText($dest,'existing conflict'); Gate 26
        if ([IO.File]::ReadAllText($dest) -ne 'existing conflict') { throw 'Clobbered an existing cache.' }
        Write-Output 'Machine-wide protected publication, idempotence and no-clobber passed.'
    }
} finally {
    if ($removeTestCache -and [IO.Directory]::Exists($cache)) { [IO.Directory]::Delete($cache,$true) }
    [IO.Directory]::Delete($root,$true)
    foreach ($n in $saved.Keys) { [Environment]::SetEnvironmentVariable($n,$saved[$n]) }
}
