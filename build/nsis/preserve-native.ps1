# Windows PowerShell 5.1. Called after the existing Medley gate. Both callers
# supply Digest(Stream); only the pinned machine helper supplies Protected-Child
# and Assert-Protected. No registry writes, code from old apps, or network I/O.
param([string[]]$InstallRoots, [string]$StorageDir, [byte[]]$ManifestBytes,
      [string[]]$OtherStorageDirs, [string]$ProtectedProgramFiles, [string]$SharedFolder)
$ErrorActionPreference = 'Stop'
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (!$ProtectedProgramFiles -and $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Cannot write to user Forge storage from an elevated process.'
}
function Native-Path([string]$path) {
    $path = $path.Replace('/','\').TrimEnd('\')
    if ($path -notmatch '^[A-Z]:\\[^\\]' -or $path.Substring(2) -match '[:"*?<>|\x00-\x1f]|~\d|[ .](?=\\|$)|\\(?:con|nul|prn|aux|com[1-9]|lpt[1-9])(?:\.|\\|$)' -or [IO.DriveInfo]::new($path.Substring(0,3)).DriveType -notin 'Fixed','Removable') {
        throw "Expected a local Forge path without links, aliases or device names: $path"
    }
    [IO.Path]::GetFullPath($path)
}
function Native-Attributes([string]$path) {
    # Do not descend through a junction (including a dangling one) or confuse
    # inaccessible with missing. Protected destination ancestors also get DAC checks.
    $p = $path.Substring(0,3)
    foreach ($name in $path.Substring(3).Split('\')) {
        $p = [IO.Path]::Combine($p,$name)
        try { $attr = [IO.File]::GetAttributes($p) }
        catch [IO.DirectoryNotFoundException] { return $null }
        catch [IO.FileNotFoundException] { return $null }
        if ($attr -band [IO.FileAttributes]::ReparsePoint) { throw "Cannot preserve through link: $p" }
    }
    $attr
}
# Use only the BCL in the privileged path; no PowerShell module auto-loading.
[void][Reflection.Assembly]::Load('System.Runtime.Serialization, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089')
$reader = [Runtime.Serialization.Json.JsonReaderWriterFactory]::CreateJsonReader($ManifestBytes,[Xml.XmlDictionaryReaderQuotas]::new())
$doc = [Xml.XmlDocument]::new(); $doc.XmlResolver = $null
try { $doc.Load($reader) } finally { $reader.Dispose() }
$pins = @{}
foreach ($item in $doc.SelectNodes('/root/item')) {
    $rel = $item.SelectSingleNode('path').InnerText
    $hash = $item.SelectSingleNode('sha256').InnerText
    $size = [long]$item.SelectSingleNode('size').InnerText
    if ($rel -notmatch '^(?:assets|ort-gpu)/(?:[\w-]+[\w.-]*/)*[\w-]+[\w.-]*$' -or $hash -notmatch '^[a-f0-9]{64}$' -or $size -le 0) { throw 'Invalid public component manifest.' }
    $pins.Add($rel.Replace('/','\'),@{sha256=$hash;size=$size})
}
if (!$pins.Count) { throw 'No public component pins supplied.' }
function Keep-Component([string]$source, [string]$rel) {
    $pin = $pins[$rel]; $target = [IO.Path]::Combine($native,$rel)
    $f = [IO.File]::OpenRead($source) # no sharing for writes/deletes until publication
    try {
        # Never copy unknown/private source bytes into a machine-readable staging file.
        if ($f.Length -ne [long]$pin.size -or (Digest $f) -ne $pin.sha256) { throw "Unrecognized Forge file (not removed); back it up before upgrading: $source" }
        if ($ProtectedProgramFiles) {
            Assert-Protected $ProtectedProgramFiles $false
            $d = Protected-Child $ProtectedProgramFiles $SharedFolder
            $d = Protected-Child $d 'native'
            foreach ($part in [IO.Path]::GetDirectoryName($rel).Split('\')) { $d = Protected-Child $d $part }
        } else { $d = [IO.Path]::GetDirectoryName($target) }
        if ($null -ne (Native-Attributes $target)) {
            if ($ProtectedProgramFiles) { Assert-Protected $target $true }
            $out = [IO.File]::OpenRead($target)
            try { if ($out.Length -ne [long]$pin.size -or (Digest $out) -ne $pin.sha256) { throw "Conflicting Forge file (not overwritten): $target" } } finally { $out.Dispose() }
            return
        }
        [void][IO.Directory]::CreateDirectory($d)
        $tmp = [IO.Path]::Combine($d,[Guid]::NewGuid().ToString('N') + '.partial')
        $f.Position = 0
        $out = [IO.File]::Open($tmp,'CreateNew','ReadWrite','None')
        try {
            try {
                $f.CopyTo($out); $out.Flush($true); $out.Position = 0
                if ((Digest $out) -ne $pin.sha256) { throw "Staged Forge copy failed verification: $source" }
            } finally { $out.Dispose() }
            if ($ProtectedProgramFiles) {
                $acl = [IO.File]::GetAccessControl($tmp)
                $acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
                [IO.File]::SetAccessControl($tmp,$acl); Assert-Protected $tmp $true
            }
            [IO.File]::Move($tmp,$target) # same-directory, atomic, never overwrite
        } finally { [IO.File]::Delete($tmp) }
    } finally { $f.Dispose() }
    [Console]::WriteLine("Preserved verified Forge file: $target")
}
function Inspect-Components([string]$directory,[string]$prefix) {
    if ($null -eq (Native-Attributes $directory)) { return }
    $stack = [Collections.Generic.Stack[string]]::new(); $stack.Push($directory)
    while ($stack.Count) {
        foreach ($entry in [IO.DirectoryInfo]::new($stack.Pop()).EnumerateFileSystemInfos()) {
            if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Cannot inspect Forge link: $($entry.FullName)" }
            if ($entry.Attributes -band [IO.FileAttributes]::Directory) { $stack.Push($entry.FullName); continue }
            $rel = $prefix + '\' + $entry.FullName.Substring($directory.Length + 1)
            if ($pins.ContainsKey($rel)) { Keep-Component $entry.FullName $rel; continue }
            # The caller has already checked and preserved these exact local
            # Medley inputs. An orphan YAML or any other file still blocks removal.
            if ($entry.Name -in 'bsrofo_sw_body.onnx','BS-Rofo-SW-Fixed.ckpt') { continue }
            if ($entry.Name -eq 'BS-Rofo-SW-Fixed.yaml' -and [IO.File]::Exists([IO.Path]::Combine($entry.DirectoryName,'BS-Rofo-SW-Fixed.ckpt'))) { continue }
            throw "Unrecognized file in the old Forge components; move it outside the old install before upgrading: $($entry.FullName)"
        }
    }
}
$roots = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
if ($ProtectedProgramFiles) {
    if ($SharedFolder -notin 'MIDI Studio Shared Models','MIDI Studio Test Shared Models') { throw 'Unexpected protected cache name.' }
    $native = [IO.Path]::Combine($ProtectedProgramFiles,$SharedFolder,'native')
} else { $native = [IO.Path]::Combine((Native-Path $StorageDir),'native') }
foreach ($r in $InstallRoots) {
    if (!$r) { continue }
    $r = Native-Path $r.Trim('"')
    # Validate every root before copying the first file, including old trees
    # different from the new install. No persistent store under a removal root.
    foreach ($storage in (@($StorageDir,$native) + $OtherStorageDirs)) {
        if (!$storage) { continue }
        $storage = Native-Path $storage
        if ($storage -eq $r -or $storage.StartsWith($r + '\',[StringComparison]::OrdinalIgnoreCase)) { throw "Move Forge storage outside the app folder before upgrading: $storage" }
    }
    [void]$roots.Add($r)
}
foreach ($r in $roots) {
    foreach ($sub in '','forge-rs','resources','resources\forge-rs') {
        $bundle = [IO.Path]::Combine($r,$sub)
        Inspect-Components ([IO.Path]::Combine($bundle,'assets')) 'assets'
        Inspect-Components ([IO.Path]::Combine($bundle,'ort-gpu')) 'ort-gpu'
    }
    foreach ($sub in 'python-engine\models','resources\python-engine\models') {
        Inspect-Components ([IO.Path]::Combine($r,$sub)) 'assets'
    }
}
