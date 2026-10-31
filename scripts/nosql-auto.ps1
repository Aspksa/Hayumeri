param([int]$ParentPid, [long]$ParentStartTicks)
# Background NoSQL manager for Windows PowerShell 5.1.
# Never blocks the web launcher; never installs Docker or deletes volumes.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).ProviderPath
$runtime = Join-Path $root '.runtime'
$statusFile = Join-Path $runtime 'nosql-auto-status.json'
$profileFile = Join-Path $runtime 'nosql-profile.json'
$credentialsFile = Join-Path $root '.env.nosql'
$logFile = Join-Path $runtime 'nosql-auto.log'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
if ((Test-Path -LiteralPath $logFile) -and (Get-Item -LiteralPath $logFile).Length -gt 1MB) {
  Move-Item -LiteralPath $logFile -Destination (Join-Path $runtime 'nosql-auto.previous.log') -Force
}
function Parent-IsAlive {
  try {
    $parent = Get-Process -Id $ParentPid -ErrorAction Stop
    return $parent.StartTime.ToUniversalTime().Ticks -eq $ParentStartTicks
  } catch { return $false }
}
function Write-State([string]$state, [string]$message, [string]$profile, [string[]]$running = @(), [double]$diskFree = -1) {
  $item = [ordered]@{
    schema = 1
    automatic = $true
    state = $state
    message = $message
    profile = $profile
    running = @($running)
    diskFreeGiB = [math]::Round($diskFree,1)
    updatedAt = (Get-Date).ToUniversalTime().ToString('o')
  }
  $temp = Join-Path $runtime ('nosql-status-' + [guid]::NewGuid().ToString('N') + '.tmp')
  try {
    [IO.File]::WriteAllText($temp, (ConvertTo-Json -InputObject $item -Depth 5 -Compress), (New-Object Text.UTF8Encoding($false)))
    if (Test-Path -LiteralPath $statusFile) { [IO.File]::Replace($temp, $statusFile, $null) }
    else { [IO.File]::Move($temp, $statusFile) }
  } catch {
    if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue }
  }
  try { Add-Content -LiteralPath $logFile -Encoding UTF8 -Value ("$($item.updatedAt) [$state] $message") } catch { }
}
function Find-Docker {
  $cmd = Get-Command docker.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cmd) { return $cmd.Source }
  $programFilesX86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
  foreach ($candidate in @(
    (Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin\docker.exe'),
    (Join-Path $programFilesX86 'Docker\Docker\resources\bin\docker.exe')
  )) { if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate } }
  return $null
}
function Docker-Memory([string]$docker) {
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $raw = & $docker info --format '{{.MemTotal}}' 2>$null
    if ($LASTEXITCODE -ne 0) { return [long]0 }
    [long]$bytes = 0
    if ([long]::TryParse(([string]$raw).Trim(),[ref]$bytes)) { return $bytes }
    return [long]0
  } catch { return [long]0 }
  finally { $ErrorActionPreference = $old }
}
function Start-DockerDesktop {
  foreach ($candidate in @(
    (Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\Docker Desktop.exe')
  )) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      try { Start-Process -FilePath $candidate -ErrorAction Stop | Out-Null; return $true }
      catch { return $false }
    }
  }
  return $false
}
function Free-Disk {
  try {
    $drive = New-Object IO.DriveInfo([IO.Path]::GetPathRoot($root))
    if ($drive.IsReady) { return $drive.AvailableFreeSpace / 1GB }
  } catch { }
  return -1
}
function Host-Memory {
  try {
    $os = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
    return @{ total=([double]$os.TotalVisibleMemorySize * 1KB);free=([double]$os.FreePhysicalMemory * 1KB) }
  } catch { return @{total=0;free=0} }
}
function Select-Profile([long]$dockerBytes) {
  if (Test-Path -LiteralPath $profileFile -PathType Leaf) {
    $json = Get-Content -LiteralPath $profileFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($json.schema -ne 1 -or $json.name -notin @('balanced','growth')) {
      throw 'Повреждён файл профиля ресурсов. Автопереключение отключено без изменения данных.'
    }
    return [string]$json.name
  }
  $memory = Host-Memory
  if ($memory.total -ge 24GB -and $memory.free -ge 9GB -and $dockerBytes -ge 12GB) { return 'growth' }
  return 'balanced'
}
function Compose-Running([string]$docker) {
  if (-not (Test-Path -LiteralPath $credentialsFile -PathType Leaf)) { return @() }
  $old=$ErrorActionPreference; $ErrorActionPreference='Continue'
  try {
    $compose = Join-Path $root 'docker-compose.nosql.yml'
    $services = & $docker compose --project-directory $root --env-file $credentialsFile -f $compose ps --services --status running 2>$null
    if ($LASTEXITCODE -ne 0) { return @() }
    return @($services | ForEach-Object { [string]$_ } | Where-Object { $_ -in @('mongodb','redis','neo4j','qdrant') } | Select-Object -Unique)
  } catch { return @() }
  finally { $ErrorActionPreference=$old }
}
function Has-ExistingVolumes([string]$docker) {
  $old=$ErrorActionPreference; $ErrorActionPreference='Continue'
  try {
    foreach ($name in @('mongodb_data','redis_data','neo4j_data','qdrant_data')) {
      & $docker volume inspect ('hayumeri-nosql_' + $name) *> $null
      if ($LASTEXITCODE -eq 0) { return $true }
    }
    return $false
  } catch { return $false }
  finally { $ErrorActionPreference=$old }
}
function Start-Stack([string]$action) {
  $exe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $script = Join-Path $PSScriptRoot 'databases.ps1'
  $stdout = Join-Path $runtime 'nosql-auto-command.out.log'
  $stderr = Join-Path $runtime 'nosql-auto-command.err.log'
  $arguments = @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"' + $script + '"'),'-Action',$action)
  $child = Start-Process -FilePath $exe -ArgumentList $arguments -WorkingDirectory $root -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  if (-not $child.WaitForExit(240000)) { return $false }
  $child.Refresh()
  return $child.ExitCode -eq 0
}
function Should-Grow([string]$docker,[long]$available,[string]$profile,[string[]]$running,[ref]$cycles) {
  # Explicit manual profile takes precedence. On 16 GB, never increase
  # resources unless both Docker and Windows have enough spare memory.
  if ($profile -ne 'balanced' -or (Test-Path -LiteralPath $profileFile)) { $cycles.Value=0;return $false }
  $mem = Host-Memory
  if ($available -lt 9GB -or $mem.total -lt 15GB -or $mem.free -lt 7GB -or $running.Count -lt 4) {
    $cycles.Value=0;return $false
  }
  $old=$ErrorActionPreference; $ErrorActionPreference='Continue'
  try {
    $stats=& $docker stats --no-stream --format '{{.Name}}|{{.MemPerc}}' 2>$null
    if ($LASTEXITCODE -ne 0) { $cycles.Value=0;return $false }
    $pressure=$false
    foreach ($line in $stats) {
      if ($line -notmatch '^hayumeri-nosql-(mongodb|redis|neo4j|qdrant)-\d+\|([0-9.,]+)%$') { continue }
      $value=0.0
      if ([double]::TryParse(($Matches[2] -replace ',','.'),[Globalization.NumberStyles]::Float,
        [Globalization.CultureInfo]::InvariantCulture,[ref]$value) -and $value -ge 85) { $pressure=$true }
    }
    if ($pressure) { $cycles.Value++ } else { $cycles.Value=0 }
    return $cycles.Value -ge 3
  } catch { $cycles.Value=0;return $false }
  finally { $ErrorActionPreference=$old }
}
$mutex=$null;$locked=$false
try {
  $sha=[Security.Cryptography.SHA256]::Create()
  try {
    $digest=$sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($root.ToLowerInvariant()))
    $lockId=[BitConverter]::ToString($digest).Replace('-','').Substring(0,24)
  } finally { $sha.Dispose() }
  $mutex=New-Object Threading.Mutex($false,('Local\Hayumeri-NoSQL-'+$lockId))
  try { $locked=$mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked=$true }
  if (-not $locked) { exit 0 }
  $docker=Find-Docker;$desktopTried=$false;$highCycles=0
  if (-not $docker) {
    Write-State 'docker-missing' 'Docker Desktop отсутствует. Веб-интерфейс работает; базы требуют однократной установки Docker.' 'balanced'
    exit 0
  }
  while (Parent-IsAlive) {
    $profile='balanced';$disk=Free-Disk
    try {
      $available=Docker-Memory $docker
      if ($available -eq 0) {
        Write-State 'docker-starting' 'Подготовка Docker Desktop без остановки сайта.' $profile @() $disk
        if (-not $desktopTried) { $desktopTried=$true;[void](Start-DockerDesktop) }
        for($i=0;$i -lt 12 -and (Parent-IsAlive);$i++) {
          Start-Sleep -Seconds 5
          $available=Docker-Memory $docker
          if ($available -gt 0) { break }
        }
        if ($available -eq 0) {
          Write-State 'docker-unavailable' 'Docker Engine не готов. Может требоваться первоначальная настройка Docker Desktop.' $profile @() $disk
          Start-Sleep -Seconds 60
          continue
        }
      }
      $profile=Select-Profile $available
      $running=@(Compose-Running $docker)
      if ($profile -eq 'growth' -and $available -lt 9GB) {
        Write-State 'memory-warning' 'Выбран growth, но Docker видит меньше 9 ГиБ. Профиль не менялся.' $profile $running $disk
      } elseif ($disk -ge 0 -and $disk -lt 3) {
        Write-State 'disk-warning' 'Менее 3 ГиБ свободно на диске Hayumeri. Новый запуск баз приостановлен.' $profile $running $disk
      } elseif (-not (Test-Path -LiteralPath $credentialsFile) -and (Has-ExistingVolumes $docker)) {
        Write-State 'credentials-missing' 'Есть тома Docker, но отсутствует прежний .env.nosql. Пароли не пересоздаются.' $profile $running $disk
      } else {
        if ($running.Count -lt 4) {
          Write-State 'starting' 'Автоматический запуск четырёх баз. При первом запуске скачиваются образы.' $profile $running $disk
          $action=if($profile -eq 'growth' -and -not (Test-Path -LiteralPath $profileFile)){'growth'}else{'start'}
          if (-not (Start-Stack $action)) {
            Write-State 'degraded' 'Запуск баз не завершён. Подробности: .runtime/nosql-auto-command.*.log' $profile $running $disk
          } else { $running=@(Compose-Running $docker) }
        }
        if ($running.Count -eq 4) {
          $message='Все 4 контейнера запущены; проверка подключений выполняется отдельно.'
          if ($disk -ge 0 -and $disk -lt 10) { $message+=' Свободно менее 10 ГиБ на диске проекта.' }
          Write-State 'running' $message $profile $running $disk
          if (Should-Grow $docker $available $profile $running ([ref]$highCycles)) {
            Write-State 'scaling' 'Три проверки подряд показали высокую загрузку памяти. Переключаемся на growth.' $profile $running $disk
            if (Start-Stack 'growth') { $highCycles=0 }
          }
        } else { Write-State 'degraded' ('Работает '+$running.Count+' из 4 контейнеров. Повторная попытка автоматическая.') $profile $running $disk }
      }
    } catch { Write-State 'error' ('Автоконтроль NoSQL: '+$_.Exception.Message) $profile @() $disk }
    for($i=0;$i -lt 150 -and (Parent-IsAlive);$i+=5) { Start-Sleep -Seconds 5 }
  }
} finally {
  if($locked -and $mutex){$mutex.ReleaseMutex()}
  if($mutex){$mutex.Dispose()}
}
