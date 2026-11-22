# Non-admin, offline, no registry/live app access. Optional real weights are
# inputs only: never package them as fixtures. Only our random temp tree is
# removed. Pass -KeepEvidence to retain the portable post-upgrade model for MIDI QA.
[CmdletBinding()]param([string]$Onnx, [string]$Checkpoint, [string]$DisposableForgeEnv, [switch]$KeepEvidence)
$ErrorActionPreference = 'Stop'
$util = Join-Path $PSScriptRoot 'preserve-medley.ps1'
$root = Join-Path ([IO.Path]::GetTempPath()) ('medley-upgrade-' + [Guid]::NewGuid().ToString('N'))
$null = [IO.Directory]::CreateDirectory($root)
$onnxName = 'bsrofo_sw_body.onnx'; $ckptName = 'BS-Rofo-SW-Fixed.ckpt'
$pin = 'fa89f1997f7120f1eb3cac19e7590653d6e6b92ba9dd2d486645d86c0667aede'
function Assert([bool]$ok, [string]$why) { if (!$ok) { throw $why } }
function Run-Case([int]$expected, [hashtable]$paths) {
    & $util @paths
    Assert ($LASTEXITCODE -eq $expected) "Expected gate $expected, got $LASTEXITCODE ($($paths.InstallRoots))."
}
function Stage([string]$from,[string]$to) {
    $null = [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($to))
    [IO.File]::Copy($from,$to) # independent disposable source, not a live hard link
}
function Start-Case([string]$name) {
    $script:case = Join-Path $root $name
    $script:old = Join-Path $case 'old app'
    $script:profile = Join-Path $case 'Local'
    $script:paths = @{ LocalDataRoot=$profile; InstallRoots=@($old) }
    $script:dest = Join-Path $profile "midi-studio\forge-env\models\bs_rofo_sw\$onnxName"
    $null = [IO.Directory]::CreateDirectory($old)
}
function Confirm-Preserved {
    Assert ([IO.File]::Exists($dest)) 'Gate returned success without a persistent graph.'
    Assert ((Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash -eq $pin) 'Wrong preserved graph.'
    Assert (@(Get-ChildItem -LiteralPath ([IO.Path]::GetDirectoryName($dest)) -Filter '*.partial').Count -eq 0) 'Partial copy leaked.'
}
try {
    Start-Case 'fresh'; Run-Case 0 $paths
    Assert (![IO.Directory]::Exists($profile)) 'Fresh install created unnecessary model storage.'
    Start-Case 'pre-Medley'; [IO.File]::WriteAllText("$old\old-settings.txt",'keep'); Run-Case 0 $paths
    Start-Case 'missing-old-Medley'; $paths.PriorMedley=$true; Run-Case 23 $paths
    Start-Case 'wrong-graph'; [IO.File]::WriteAllText("$old\$onnxName",'unknown'); Run-Case 21 $paths
    Assert ([IO.File]::ReadAllText("$old\$onnxName") -eq 'unknown') 'Changed unverified old graph.'
    Start-Case 'wrong-checkpoint'; [IO.File]::WriteAllText("$old\$ckptName",'unknown'); Run-Case 21 $paths
    Start-Case 'inside-uninstall-tree'; $paths.LocalDataRoot="$old\user"; Run-Case 24 $paths
    Start-Case 'junction'; $outside = "$case\outside"; $null=[IO.Directory]::CreateDirectory($outside)
    $null = New-Item -ItemType Junction -Path $profile -Target $outside
    Run-Case 24 $paths
    [IO.Directory]::Delete($profile); Assert (@([IO.Directory]::EnumerateFileSystemEntries($outside)).Count -eq 0) 'Wrote through a junction.'
    if ($Checkpoint) {
        Start-Case 'ckpt-only'; $modelDir = "$case\custom models\bs_rofo_sw"; $paths.ModelsDirs=@("$case\custom models")
        $copy = "$modelDir\$ckptName"; Stage $Checkpoint $copy; Run-Case 22 $paths
        Assert ((Get-FileHash -LiteralPath $copy).Hash -eq '24e7d35ee9c64415673d3fd33e06a67cac2c103c5df6267ba1576459c775916e') 'Old checkpoint changed.'
        Assert (![IO.File]::Exists($dest)) 'Unverified conversion was accepted.'
        [IO.Directory]::Delete($case,$true)
        if ($DisposableForgeEnv) {
            # Supply a disposable, already-provisioned python + msst + .ready
            # under TEMP, with NO models. Never run against the user's engine.
            $engine = [IO.Path]::GetFullPath($DisposableForgeEnv)
            Assert ($engine.StartsWith([IO.Path]::GetTempPath(),[StringComparison]::OrdinalIgnoreCase) -and ![IO.Directory]::Exists("$engine\models")) 'Use a disposable model-free Forge runtime under TEMP.'
            Start-Case 'convert-ckpt-only'; $ckptDir = "$old\resources\python-engine\models\bs_rofo_sw"
            Stage $Checkpoint "$ckptDir\$ckptName"
            Stage ([IO.Path]::Combine([IO.Path]::GetDirectoryName($Checkpoint),'BS-Rofo-SW-Fixed.yaml')) "$ckptDir\BS-Rofo-SW-Fixed.yaml"
            $paths.ForgeDirs=@($engine); $paths.AutoConvert=$true
            $paths.ConverterDir=[IO.Path]::GetFullPath("$PSScriptRoot\..\..\python-engine")
            Run-Case 0 $paths; Confirm-Preserved
            [IO.Directory]::Delete($old,$true)
            Assert ([IO.File]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($dest),$ckptName)))) 'Endangered original checkpoint was not retained.'
            Run-Case 0 $paths; Confirm-Preserved
            [IO.Directory]::Delete($case,$true)
        }
    }
    if ($Onnx) {
        foreach ($kind in 'electron','tauri','custom-forge','custom-models','registry-store','legacy-model-layout','portable') {
            Start-Case $kind; $source = $null
            switch ($kind) {
                'electron' { $source = "$old\resources\forge-rs\assets\bs_rofo_sw\$onnxName" }
                'tauri' { $source = "$old\assets\bs_rofo_sw\$onnxName"; $paths.InstallRoots=@("$case\new",$old); $paths.PriorMedley=$true }
                'portable' { $source = "$old\assets\bs_rofo_sw\$onnxName" }
                'custom-forge' { $source="$case\custom engine\models\bs_rofo_sw\$onnxName"; $paths.SettingsFile="$case\settings.json"; @{paths=@{forgeEnvDir="$case\custom engine"}} | ConvertTo-Json | Set-Content -LiteralPath $paths.SettingsFile -Encoding UTF8 }
                'custom-models' { $source="$case\custom models\bs_rofo_sw\$onnxName"; $paths.SettingsFile="$case\settings.json"; @{paths=@{modelsDir="$case\custom models"}} | ConvertTo-Json | Set-Content -LiteralPath $paths.SettingsFile -Encoding UTF8 }
                'registry-store' { $source="$case\recorded\models\bs_rofo_sw\$onnxName"; $paths.ForgeDirs=@("$case\recorded") }
                'legacy-model-layout' { $source="$case\old env\models\onnx\$onnxName"; $paths.ForgeDirs=@("$case\old env") }
            }
            Stage $Onnx $source
            Run-Case 0 $paths; Confirm-Preserved
            [IO.File]::Delete($source); [IO.Directory]::Delete($old,$true) # drop the disposable old tree
            Run-Case 0 $paths; Confirm-Preserved
            if (!($KeepEvidence -and $kind -eq 'portable')) { [IO.Directory]::Delete($case,$true) }
        }
        Start-Case 'conflict'; Stage $Onnx "$old\$onnxName"; $null=[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($dest))
        [IO.File]::WriteAllText($dest,'keep conflict'); Run-Case 21 $paths
        Assert ([IO.File]::ReadAllText($dest) -eq 'keep conflict') 'Overwrote a conflicting local model.'
        Assert ([IO.File]::Exists("$old\$onnxName")) 'Removed the source despite conflict.'
        [IO.Directory]::Delete($case,$true)
    }
    Write-Output 'Disposable migration checks passed.'
    if ($KeepEvidence -and $Onnx) { Write-Output "Preserved portable graph: $root\portable\Local\midi-studio\forge-env\models\bs_rofo_sw\$onnxName" }
} finally { if (!$KeepEvidence) { [IO.Directory]::Delete($root,$true) } }
