param(
  [string]$Commit,
  [int]$ParentPid = 0,
  [switch]$SelfTest
)
# Self-contained updater. Never requires administrator rights.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).ProviderPath
$runtime = Join-Path $root '.runtime'
$updateRoot = Join-Path $runtime 'updates'
$stateFile = Join-Path $runtime 'update-state.json'
$statusFile = Join-Path $runtime 'update-progress.json'
$logFile = Join-Path $runtime 'update.log'
$backupPath = ''
$backedUp = @()
$activated = $false

function Log([string]$message) {
  New-Item -ItemType Directory -Path $runtime -Force | Out-Null
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
  Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8
  Write-Host $message
}
function Status([string]$state, [string]$message) {
  $value = @{ state=$state; message=$message; commit=$Commit; updatedAt=(Get-Date).ToString('o') }
  $tmp = $statusFile + '.tmp'
  ($value | ConvertTo-Json -Compress) | Set-Content -LiteralPath $tmp -Encoding UTF8
  Move-Item -LiteralPath $tmp -Destination $statusFile -Force
  Log "[$state] $message"
}
function Sha1Blob([byte[]]$bytes) {
  $prefix = [Text.Encoding]::ASCII.GetBytes(('blob ' + $bytes.Length + [char]0))
  $buffer = New-Object 'byte[]' ($prefix.Length + $bytes.Length)
  [Array]::Copy($prefix, $buffer, $prefix.Length)
  [Array]::Copy($bytes, 0, $buffer, $prefix.Length, $bytes.Length)
  $sha = [Security.Cryptography.SHA1]::Create()
  try { return [BitConverter]::ToString($sha.ComputeHash($buffer)).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
}
function GithubJson([string]$url) {
  return Invoke-RestMethod -Uri $url -UseBasicParsing -TimeoutSec 30 -Headers @{
    'User-Agent' = 'Hayumeri-local-updater'
    'Accept' = 'application/vnd.github+json'
  }
}
function RelativeSafe([string]$relative) {
  if ([string]::IsNullOrWhiteSpace($relative) -or $relative.StartsWith('/') -or $relative.Contains('\') -or
      $relative -match '[\x00-\x1f:*?"<>|]' -or $relative -match '(^|/)\.\.?(/|$)') { return $false }
  foreach ($piece in $relative.Split('/')) {
    if ($piece -eq '' -or $piece.EndsWith('.') -or $piece.EndsWith(' ') -or
        $piece -match '^(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$') { return $false }
  }
  return $true
}
function ProtectedPath([string]$relative) {
  $path = $relative.Replace('\', '/').ToLowerInvariant()
  $top = $path.Split('/')[0]
  if (@('.git','.runtime','node_modules','logs','data','vault','documents','uploads','storage','disk','backups','user-data','dist') -contains $top) { return $true }
  if ($path -eq 'config/launcher.json' -or $path -eq '.env' -or $path.StartsWith('.env.')) { return $true }
  return $false
}
function Restore-Backup {
  if (-not $backupPath -or -not (Test-Path -LiteralPath (Join-Path $backupPath 'restore.json'))) { return }
  $items = @(Get-Content -LiteralPath (Join-Path $backupPath 'restore.json') -Raw -Encoding UTF8 | ConvertFrom-Json)
  foreach ($item in $items) {
    if (-not (RelativeSafe $item.path)) { throw "Некорректная запись резервной копии: $($item.path)" }
    $target = Join-Path $root $item.path
    if ($item.existed) {
      $source = Join-Path (Join-Path $backupPath 'files') $item.path
      New-Item -ItemType Directory -Force -Path (Split-Path $target -Parent) | Out-Null
      Copy-Item -LiteralPath $source -Destination $target -Force
    } elseif (Test-Path -LiteralPath $target -PathType Leaf) {
      Remove-Item -LiteralPath $target -Force
    }
  }
  Log 'Резервная копия восстановлена. Пользовательские данные не затронуты.'
}
function Start-Hayumeri {
  $bat = Join-Path $root 'Hayumeri.bat'
  if (-not (Test-Path -LiteralPath $bat -PathType Leaf)) { throw 'Не найден Hayumeri.bat для перезапуска.' }
  $args = '/D /C call "' + $bat + '"'
  return Start-Process -FilePath $env:ComSpec -WorkingDirectory $root -ArgumentList $args -PassThru
}
function Wait-ForSite([datetime]$since, [int]$timeoutSeconds = 120) {
  $status = Join-Path $runtime 'launcher-status.json'
  for ($i=0; $i -lt $timeoutSeconds; $i++) {
    if (Test-Path -LiteralPath $status) {
      try {
        $info = Get-Content -LiteralPath $status -Raw -Encoding UTF8 | ConvertFrom-Json
        if ([datetime]$info.updatedAt -ge $since) {
          if ($info.state -eq 'ОШИБКА') { return $false }
          if ($info.state -eq 'РАБОТАЕТ' -and $info.address -match '^http://127\.0\.0\.1:\d+/$') {
            $response = Invoke-WebRequest -Uri $info.address -UseBasicParsing -TimeoutSec 3
            if ($response.StatusCode -eq 200 -and $response.Content.Contains('<title>Hayumeri</title>')) { return $true }
          }
        }
      } catch { }
    }
    Start-Sleep -Seconds 1
  }
  return $false
}
if ($SelfTest) {
  if (-not (RelativeSafe 'scripts/start.ps1')) { throw 'Bad path guard.' }
  if (RelativeSafe '../secret.txt' -or (RelativeSafe 'sub/../../file') -or (RelativeSafe 'C:\Windows')) { throw 'Unsafe paths allowed.' }
  if (-not (ProtectedPath '.runtime/launcher-status.json') -or -not (ProtectedPath 'config/launcher.json')) { throw 'User data guard failed.' }
  if ((Sha1Blob ([Text.Encoding]::ASCII.GetBytes('test'))) -ne '30d74d258442c7c65512eafab474568dd706c430') { throw 'Git blob hash error.' }
  Write-Host 'Updater self-test passed.'
  exit 0
}
$previousVersion = if (Test-Path -LiteralPath $stateFile) {
  Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8
} else { '' }
try {
  if ($Commit -notmatch '^[a-f0-9]{40}$') { throw 'Недопустимый идентификатор коммита.' }
  if (Test-Path -LiteralPath (Join-Path $root '.git')) { throw 'Обновление Git-клона вручную: используйте git pull.' }
  New-Item -ItemType Directory -Path $updateRoot -Force | Out-Null
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $folder = Join-Path $updateRoot ('stage-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $folder | Out-Null
  $zipPath = Join-Path $folder 'github.zip'
  $staged = Join-Path $folder 'files'
  New-Item -ItemType Directory -Path $staged | Out-Null
  Status 'СКАЧИВАНИЕ' 'Скачивание точной версии из GitHub.'
  $api = 'https://api.github.com/repos/Aspksa/Hayumeri'
  $remote = GithubJson ($api + '/git/commits/' + $Commit)
  if ($remote.sha -ne $Commit -or $remote.tree.sha -notmatch '^[a-f0-9]{40}$') { throw 'GitHub не подтвердил коммит и дерево.' }
  $tree = GithubJson ($api + '/git/trees/' + $remote.tree.sha + '?recursive=1')
  if ($tree.truncated -or -not $tree.tree) { throw 'Неполное GitHub-дерево. Обновление отменено.' }
  $expected = @{}
  foreach ($node in $tree.tree) {
    if ($node.type -eq 'blob') {
      if ($node.mode -ne '100644' -and $node.mode -ne '100755') { throw "Недопустимый режим файла: $($node.path)" }
      if (-not (RelativeSafe ([string]$node.path))) { throw 'Недопустимое имя файла в GitHub.' }
      $expected[[string]$node.path] = [string]$node.sha
    } elseif ($node.type -ne 'tree') { throw 'Вложенные репозитории и ссылки не поддерживаются.' }
  }
  if ($expected.Count -lt 8 -or $expected.Count -gt 2000) { throw 'Необычное количество файлов обновления.' }
  Invoke-WebRequest -Uri ('https://codeload.github.com/Aspksa/Hayumeri/zip/' + $Commit) -OutFile $zipPath -TimeoutSec 180 -UseBasicParsing
  if ((Get-Item -LiteralPath $zipPath).Length -gt 100MB) { throw 'Слишком большой архив обновления.' }

  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [IO.Compression.ZipFile]::OpenRead($zipPath)
  $received = @{}
  $length = [long]0
  try {
    foreach ($entry in $archive.Entries) {
      if ($entry.FullName.EndsWith('/')) { continue }
      $parts = $entry.FullName.Split('/')
      if ($parts.Count -lt 2 -or $parts[0] -notmatch '^Hayumeri-[a-fA-F0-9]{40}$') { throw 'Неизвестный формат GitHub ZIP.' }
      $relative = ($parts | Select-Object -Skip 1) -join '/'
      if (-not (RelativeSafe $relative) -or -not $expected.ContainsKey($relative) -or $received.ContainsKey($relative)) {
        throw "Неожиданный путь в архиве: $relative"
      }
      $length += [long]$entry.Length
      if ($entry.Length -gt 20MB -or $length -gt 250MB) { throw 'Превышен лимит распакованных файлов.' }
      $stream = $entry.Open()
      try {
        $buffer = New-Object IO.MemoryStream
        try {
          $stream.CopyTo($buffer)
          $bytes = $buffer.ToArray()
        } finally { $buffer.Dispose() }
      } finally { $stream.Dispose() }
      if ((Sha1Blob $bytes) -ne $expected[$relative]) { throw "Неверная контрольная сумма Git-объекта: $relative" }
      $received[$relative] = $true
      if (-not (ProtectedPath $relative)) {
        $dest = Join-Path $staged $relative
        New-Item -ItemType Directory -Path (Split-Path $dest -Parent) -Force | Out-Null
        [IO.File]::WriteAllBytes($dest, $bytes)
      }
    }
  } finally { $archive.Dispose() }
  if ($received.Count -ne $expected.Count) { throw 'Не все файлы репозитория присутствуют в архиве.' }
  if (-not (Test-Path -LiteralPath (Join-Path $staged 'Hayumeri.bat'))) { throw 'В архиве нет файла запуска.' }
  if (-not (Test-Path -LiteralPath (Join-Path $staged 'scripts\start.ps1'))) { throw 'В архиве нет PowerShell-запуска.' }
  Status 'ПРОВЕРЕНО' ('Проверены контрольные суммы ' + $received.Count + ' файлов GitHub.')

  # Wait for Vite, parent launcher and the mutex to finish before copying.
  if ($ParentPid -gt 0) {
    for ($i = 0; $i -lt 30; $i++) {
      if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { break }
      Start-Sleep -Seconds 1
    }
  }
  Start-Sleep -Seconds 3
  $backupPath = Join-Path $updateRoot ('backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + $Commit.Substring(0,8))
  New-Item -ItemType Directory -Path (Join-Path $backupPath 'files') -Force | Out-Null
  $items = @()
  Get-ChildItem -LiteralPath $staged -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($staged.Length).TrimStart('\').Replace('\','/')
    if (-not (RelativeSafe $rel)) { throw "Недопустимое имя при установке: $rel" }
    $dest = Join-Path $root $rel
    $exists = Test-Path -LiteralPath $dest -PathType Leaf
    if ($exists) {
      $copy = Join-Path (Join-Path $backupPath 'files') $rel
      New-Item -ItemType Directory -Path (Split-Path $copy -Parent) -Force | Out-Null
      Copy-Item -LiteralPath $dest -Destination $copy
    }
    $items += @{ path = $rel; existed = [bool]$exists }
  }
  $items | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $backupPath 'restore.json') -Encoding UTF8
  Status 'УСТАНОВКА' ('Резервная копия создана. Заменяется ' + $items.Count + ' файлов.')
  try {
    foreach ($item in $items) {
      $source = Join-Path $staged $item.path
      $dest = Join-Path $root $item.path
      New-Item -ItemType Directory -Path (Split-Path $dest -Parent) -Force | Out-Null
      Copy-Item -LiteralPath $source -Destination $dest -Force
    }
    $activated = $true
    Status 'ПЕРЕЗАПУСК' 'Запуск установленной версии и проверка HTTP.'
    $since = Get-Date
    $started = Start-Hayumeri
    if (-not (Wait-ForSite $since 120)) { throw 'Обновлённая версия не прошла проверку запуска за 120 секунд.' }
    (@{ commit=$Commit; updatedAt=(Get-Date).ToString('o') } | ConvertTo-Json) | Set-Content -LiteralPath $stateFile -Encoding UTF8
    Status 'ГОТОВО' 'Обновление успешно установлено и проверено.'
    $activated = $false
    Remove-Item -LiteralPath $folder -Force -Recurse -ErrorAction SilentlyContinue
    exit 0
  } catch {
    Log ('[ОШИБКА] ' + $_.Exception.Message)
    if ($started -and -not $started.HasExited) {
      & taskkill.exe /PID $started.Id /T /F 2>$null | Out-Null
      Start-Sleep -Seconds 2
    }
    Restore-Backup
    if ($previousVersion) { Set-Content -LiteralPath $stateFile -Value $previousVersion -Encoding UTF8 }
    elseif (Test-Path -LiteralPath $stateFile) { Remove-Item -LiteralPath $stateFile -Force }
    $activated = $false
    Status 'ОТКАТ' 'Сбой обновления: предыдущая версия восстановлена.'
    Start-Hayumeri | Out-Null
    exit 1
  }
} catch {
  Log ('[ОШИБКА] ' + $_.Exception.Message)
  if ($activated) {
    try { Restore-Backup; Status 'ОТКАТ' 'Предыдущая версия восстановлена.'; Start-Hayumeri | Out-Null }
    catch { Log ('[КРИТИЧЕСКАЯ ОШИБКА] ' + $_.Exception.Message) }
  } else {
    Status 'ОШИБКА' ('Обновление не установлено: ' + $_.Exception.Message)
    # Original server already exited; always restore working application.
    try { Start-Hayumeri | Out-Null } catch { Log ('Не удалось открыть старую версию: ' + $_.Exception.Message) }
  }
  exit 1
}
