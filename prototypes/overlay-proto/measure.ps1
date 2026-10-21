param([int]$RootPid, [string]$Label)
# Sum working set and private bytes over a process and all its descendants.
$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name
$tree = @($RootPid)
$frontier = @($RootPid)
while ($frontier.Count) {
  $kids = @($all | Where-Object { $frontier -contains $_.ParentProcessId } | ForEach-Object { $_.ProcessId })
  $kids = @($kids | Where-Object { $tree -notcontains $_ })
  $tree += $kids
  $frontier = $kids
}
$rows = foreach ($id in $tree) {
  $p = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($p) {
    $type = ''
    $cl = (Get-CimInstance Win32_Process -Filter "ProcessId=$id").CommandLine
    if ($cl -match '--type=([a-z-]+)') { $type = $Matches[1] }
    [pscustomobject]@{ Pid = $id; Name = $p.ProcessName; Type = $type;
      WS_MB = [math]::Round($p.WorkingSet64 / 1MB, 1); Private_MB = [math]::Round($p.PrivateMemorySize64 / 1MB, 1) }
  }
}
"== $Label (root $RootPid) =="
$rows | Format-Table -AutoSize | Out-String -Width 200
"TOTAL processes={0} WS={1:N1} MB Private={2:N1} MB" -f $rows.Count, ($rows | Measure-Object WS_MB -Sum).Sum, ($rows | Measure-Object Private_MB -Sum).Sum
