# Windows PowerShell 5.1. Offline; no registry writes or elevated user code.
# The installer invokes -Installer under a non-elevated token. Explicit paths use
# no live profile, drive, environment, or registry discovery (including in tests).
[CmdletBinding(DefaultParameterSetName='Explicit')]
param(
    [Parameter(Mandatory,ParameterSetName='Installer')][switch]$Installer,
    [Parameter(Mandatory,ParameterSetName='Explicit')][string]$LocalDataRoot,
    [Parameter(ParameterSetName='Explicit')][string[]]$InstallRoots = @(),
    [Parameter(ParameterSetName='Explicit')][string[]]$ForgeDirs = @(),
    [Parameter(ParameterSetName='Explicit')][string[]]$ModelsDirs = @(),
    [Parameter(ParameterSetName='Explicit')][string]$SettingsFile,
    [Parameter(ParameterSetName='Explicit')][switch]$PriorMedley,
    [Parameter(ParameterSetName='Explicit')][string]$ConverterDir,
    [Parameter(ParameterSetName='Explicit')][switch]$AutoConvert
)
$ErrorActionPreference = 'Stop'
$onnx = 'bsrofo_sw_body.onnx'
$ckpt = 'BS-Rofo-SW-Fixed.ckpt'
$yaml = 'BS-Rofo-SW-Fixed.yaml'
$pins = @{
    $onnx = 'fa89f1997f7120f1eb3cac19e7590653d6e6b92ba9dd2d486645d86c0667aede'
    $ckpt = '24e7d35ee9c64415673d3fd33e06a67cac2c103c5df6267ba1576459c775916e'
    $yaml = 'f9fada9f94e5ba2d2e4600196299459294bc5f532b314c209cc156ac63e4329b'
}
$failure = 24
function Stop-Upgrade([int]$code, [string]$reason) { $script:failure = $code; throw $reason }
function Local-Path([string]$path) {
    # Never read a network URL/share, NT device, ADS or an ambiguous alias. In
    # particular, a DOS short path must not defeat the subtree containment check.
    if ($path -notmatch '^[a-z]:[\\/]' -or $path.Substring(2) -match '[:"*?<>|\x00-\x1f]|~\d|[ .](?=[\\/]|$)') {
        Stop-Upgrade 24 "Expected an absolute local path without aliases: $path"
    }
    [IO.Path]::GetFullPath($path).TrimEnd('\')
}
function Attributes([string]$path) {
    try { [IO.File]::GetAttributes($path) }
    catch [IO.FileNotFoundException] { return $null }
    catch [IO.DirectoryNotFoundException] { return $null }
}
function Check-Ancestors([string]$path) {
    for ($p = $path; $p; $p = [IO.Path]::GetDirectoryName($p)) {
        $attr = Attributes $p
        if ($null -ne $attr -and ($attr -band [IO.FileAttributes]::ReparsePoint)) {
            Stop-Upgrade 24 "Move the model to an ordinary local folder before updating (link or junction: $p)."
        }
    }
}
function Inside([string]$path, [string]$root) {
    $path -eq $root -or $path.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)
}
function New-PathSet { ,([Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)) }
function Digest([IO.Stream]$stream) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-','') } finally { $sha.Dispose() }
}
function Matches([string]$path, [string]$name) {
    $f = [IO.File]::OpenRead($path)
    try { (Digest $f) -eq $pins[$name] } finally { $f.Dispose() }
}
function Keep-File([string]$from, [string]$name, [string]$directory = $dest) {
    $to = [IO.Path]::Combine($directory,$name)
    Check-Ancestors $to
    if ($null -ne (Attributes $to)) {
        if (!(Matches $to $name)) { Stop-Upgrade 21 "Conflicting file (not overwritten): $to" }
        return
    }
    [void][IO.Directory]::CreateDirectory($directory)
    $tmp = [IO.Path]::Combine($directory, [Guid]::NewGuid().ToString('N') + '.partial')
    $inputFile = [IO.File]::OpenRead($from)
    try {
        # CREATE_NEW and a same-directory rename: never overwrite a competing
        # import, and never expose a partial file at the model's canonical name.
        $stage = [IO.File]::Open($tmp,'CreateNew','ReadWrite','None')
        try {
            try {
                $inputFile.CopyTo($stage); $stage.Flush($true); $stage.Position = 0
                if ((Digest $stage) -ne $pins[$name]) { Stop-Upgrade 21 "Copied file failed SHA-256: $from" }
            } finally { $stage.Dispose() }
            [IO.File]::Move($tmp,$to)
        } finally { [IO.File]::Delete($tmp) }
    } finally { $inputFile.Dispose() }
}
function Add-Candidate([string]$path, $set) {
    $attr = Attributes $path
    if ($null -ne $attr) {
        Check-Ancestors $path
        if ($attr -band [IO.FileAttributes]::Directory) { Stop-Upgrade 21 "Expected a model file: $path" }
        [void]$set.Add($path)
    }
}
function Convert-Checkpoint([string]$checkpoint) {
    $runtime = $null
    foreach ($dir in (@($defaultEnv) + $ForgeDirs)) {
        if (!$dir) { continue }
        $dir = Local-Path $dir
        if ([IO.File]::Exists("$dir\.ready") -and [IO.File]::Exists("$dir\python\python.exe") -and [IO.File]::Exists("$dir\msst\models\bs_roformer\bs_roformer.py")) {
            $runtime = $dir; break
        }
    }
    $kit = $ConverterDir
    if ($Installer) {
        $kit = [IO.Path]::Combine($LocalDataRoot,$product,"medley-import-$env:MS_MEDLEY_VERSION")
        foreach ($root in $roots) { if (Inside $kit $root) { Stop-Upgrade 24 "Move the installation outside $kit first." } }
        foreach ($name in 'import_medley_checkpoint.py','export_bsrofo_body.py') {
            $script = [IO.Path]::Combine($PSScriptRoot,$name)
            $f = [IO.File]::OpenRead($script)
            try { $pins[$name] = Digest $f } finally { $f.Dispose() }
            Keep-File $script $name $kit
        }
    }
    $config = [IO.Path]::Combine([IO.Path]::GetDirectoryName($checkpoint),$yaml)
    Check-Ancestors $config
    if ($AutoConvert -and $kit -and $runtime -and [IO.File]::Exists($config) -and (Matches $config $yaml)) {
        # Start only the local, provisioned Forge interpreter; arguments are
        # paths, never interpolated shell code. Use the packaged converter, not
        # a script from the old installation or a user-selected command line.
        $converter = [IO.Path]::Combine($ConverterDir,'import_medley_checkpoint.py')
        & "$runtime\python\python.exe" -I $converter "$runtime\msst" $checkpoint $target
        if ($LASTEXITCODE -eq 0 -and [IO.File]::Exists($target) -and (Matches $target $onnx)) { return }
    }
    Stop-Upgrade 22 "Checkpoint retained: $checkpoint. In a normal PowerShell session run your Forge python.exe -I `"$kit\import_medley_checkpoint.py`" `"<Forge env>\msst`" `"$checkpoint`" `"$target`", with the original sibling YAML. Rerun setup after successful verification."
}
try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    if (([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        Stop-Upgrade 25 'Run preservation from a non-administrator session.'
    }
    $graphs = New-PathSet; $checkpoints = New-PathSet; $roots = New-PathSet; $modelBases = New-PathSet
    $product = 'midi-studio'
    $machineRoots = New-PathSet
    if ($Installer) {
        $testProduct = $env:MS_MEDLEY_PRODUCT -ne 'MIDI Studio'
        if ($testProduct) { $product = $env:MS_MEDLEY_PRODUCT }
        $LocalDataRoot = [Environment]::GetFolderPath('LocalApplicationData')
        $InstallRoots = @($env:MS_MEDLEY_TARGET, $env:MS_MEDLEY_TAURI, $env:MS_MEDLEY_ELECTRON, $env:MS_MEDLEY_WIX)
        $PriorMedley = $env:MS_MEDLEY_OLD_VERSION -match '^3\.1\.0(?:$|[+-])'
        if ($env:MS_MEDLEY_ALL_USERS -eq '1') {
            foreach ($registered in $env:MS_MEDLEY_TAURI,$env:MS_MEDLEY_ELECTRON,$env:MS_MEDLEY_WIX) {
                if ($registered) { [void]$machineRoots.Add((Local-Path $registered.Trim('"'))) }
            }
        }
        $SettingsFile = [IO.Path]::Combine([Environment]::GetFolderPath('ApplicationData'),$product,'midi-studio-settings.json')
        $ForgeDirs = @($env:MS_MEDLEY_STORAGE, $env:MS_MEDLEY_OLD_STORAGE)
        $ConverterDir = $PSScriptRoot
        $AutoConvert = $env:MS_MEDLEY_WAS_ELEVATED -eq '0' -and [Environment]::UserInteractive
        if (!$testProduct) {
            $ForgeDirs += @($env:MIDI_STUDIO_FORGE_ENV_DIR, "$LocalDataRoot\midi-forge", ([Environment]::GetFolderPath('CommonApplicationData') + '\midi-studio\forge-env'))
            $ModelsDirs += $env:MIDI_STUDIO_MODELS_DIR
            if ($env:MIDI_STUDIO_USER_DATA) { $SettingsFile = [IO.Path]::Combine($env:MIDI_STUDIO_USER_DATA,'midi-studio-settings.json') }
            if ($env:FORGE_RS_ROFO_MODEL) { Add-Candidate (Local-Path $env:FORGE_RS_ROFO_MODEL) $graphs }
            foreach ($drive in [IO.DriveInfo]::GetDrives()) {
                if ($drive.DriveType -eq 'Fixed' -and $drive.IsReady) { $ForgeDirs += ($drive.Name + 'MIDI Studio Forge') }
            }
            # Both app and installer have used 32/64-bit views and HKCU/HKLM.
            foreach ($hive in 'CurrentUser','LocalMachine') { foreach ($view in 'Registry32','Registry64') {
                $reg = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive,$view)
                try {
                    $key = $reg.OpenSubKey('Software\StarsationX\MIDI Studio')
                    if ($key) { try { $ForgeDirs += $key.GetValue('ForgeStorageDir') } finally { $key.Dispose() } }
                } finally { $reg.Dispose() }
            }}
        }
    }
    $defaultEnv = [IO.Path]::Combine((Local-Path $LocalDataRoot),$product,'forge-env')
    $dest = [IO.Path]::Combine($defaultEnv,'models','bs_rofo_sw')
    if ($SettingsFile -and $null -ne (Attributes (Local-Path $SettingsFile))) {
        $settings = [IO.File]::ReadAllText($SettingsFile) | ConvertFrom-Json
        $ForgeDirs += $settings.paths.forgeEnvDir; $ModelsDirs += $settings.paths.modelsDir
    }
    foreach ($root in $InstallRoots) {
        if (!$root) { continue }
        $root = Local-Path ($root.Trim('"'))
        if ($root.Length -lt 4 -or (Inside $dest $root)) { Stop-Upgrade 24 "Choose an install folder outside persistent Forge storage: $root" }
        Check-Ancestors $root
        if ($roots.Add($root) -and $null -ne (Attributes $root)) {
            foreach ($rel in 'assets','resources\forge-rs\assets','forge-rs\assets','python-engine\models','resources\python-engine\models') {
                [void]$modelBases.Add([IO.Path]::Combine($root,$rel))
            }
            # Discover nested bundles, not just a hard-coded Tauri path. Never
            # recurse into directory junctions (they do not belong to the tree).
            $dirs = [Collections.Generic.Stack[string]]::new(); $dirs.Push($root)
            while ($dirs.Count) {
                foreach ($entry in [IO.DirectoryInfo]::new($dirs.Pop()).EnumerateFileSystemInfos()) {
                    if ($entry.Name -eq $onnx) { Add-Candidate $entry.FullName $graphs }
                    elseif ($entry.Name -eq $ckpt) { Add-Candidate $entry.FullName $checkpoints }
                    elseif (($entry.Attributes -band [IO.FileAttributes]::Directory) -and !($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) { $dirs.Push($entry.FullName) }
                }
            }
            foreach ($exe in 'MIDI Studio.exe','MIDI Studio Expressive.exe') {
                $path = [IO.Path]::Combine($root,$exe)
                if ($null -ne (Attributes $path) -and ($exe -eq 'MIDI Studio Expressive.exe' -or [Diagnostics.FileVersionInfo]::GetVersionInfo($path).ProductVersion -match '^3\.1\.0(?:$|[.+-])')) { $PriorMedley = $true }
            }
        }
    }
    foreach ($dir in (@($defaultEnv) + $ForgeDirs)) { if ($dir) { $ModelsDirs += [IO.Path]::Combine((Local-Path $dir),'models') } }
    foreach ($dir in $ModelsDirs) { if ($dir) { [void]$modelBases.Add((Local-Path $dir)) } }
    foreach ($base in $modelBases) { foreach ($sub in 'bs_rofo_sw','onnx','') {
        $d = [IO.Path]::Combine($base,$sub)
        Add-Candidate ([IO.Path]::Combine($d,$onnx)) $graphs
        Add-Candidate ([IO.Path]::Combine($d,$ckpt)) $checkpoints
    }}
    $target = [IO.Path]::Combine($dest,$onnx)
    Check-Ancestors $target
    $source = $null
    if ($graphs.Contains($target)) {
        if (!(Matches $target $onnx)) { Stop-Upgrade 21 "Conflicting file (not overwritten): $target" }
        $source = $target
    }
    foreach ($file in $graphs) {
        if ($file -eq $source) { continue }
        if (!(Matches $file $onnx)) { Stop-Upgrade 21 "Unexpected Medley ONNX SHA-256; back up this file separately: $file" }
        if (!$source) { $source = $file }
    }
    $firstCheckpoint = $null
    foreach ($file in $checkpoints) {
        $endangered = $false
        foreach ($root in $roots) { if (Inside $file $root) { $endangered = $true; break } }
        if ($source -and !$endangered) { continue }
        if (!(Matches $file $ckpt)) { Stop-Upgrade 21 "Unexpected checkpoint SHA-256; nothing was removed: $file" }
        if (!$firstCheckpoint) { $firstCheckpoint = $file }
        if ($endangered) {
            $config = [IO.Path]::Combine([IO.Path]::GetDirectoryName($file),$yaml)
            Check-Ancestors $config
            if (($null -eq (Attributes $config)) -or !(Matches $config $yaml)) { Stop-Upgrade 21 "Back up the checkpoint and original YAML outside the install directory first: $file" }
            Keep-File $config $yaml; Keep-File $file $ckpt
        }
    }
    if (!$source -and $firstCheckpoint) {
        Convert-Checkpoint $firstCheckpoint
        $source = $target
    }
    if (!$source) {
        if ($PriorMedley) { Stop-Upgrade 23 "Old Medley installation detected. Restore the original $onnx into $dest before updating." }
        Write-Output 'No prior Medley model. Nothing to preserve.'
    } elseif ($source -ne $target) { Keep-File $source $onnx; Write-Output "Verified and preserved: $target" }
    else { Write-Output "Already preserved: $target" }
    if ($source -and $machineRoots.Count) {
        $shared = $PriorMedley -and $env:MS_MEDLEY_TAURI
        foreach ($r in $machineRoots) {
            foreach ($f in $graphs) { if (Inside $f $r) { $shared = $true; break } }
            foreach ($f in $checkpoints) { if (Inside $f $r) { $shared = $true; break } }
        }
        if ($shared) {
            [IO.File]::WriteAllText("$PSScriptRoot\medley-shared-input.txt",$target,[Text.UnicodeEncoding]::new($false,$false))
            exit 10 # installer must finish shared preservation or stop
        }
    }
    exit 0
} catch {
    $message = $_.Exception.Message
    [Console]::Error.WriteLine($message)
    if ($Installer) {
        try { [IO.File]::WriteAllText("$PSScriptRoot\medley-error.txt",$message,[Text.UnicodeEncoding]::new($false,$false)) } catch {}
    }
    exit $failure
}
