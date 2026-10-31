param(
  [ValidateSet('start','stop','status','check','logs','stats','resources','balanced','growth','help')]
  [string]$Action = 'start'
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).ProviderPath
$compose = Join-Path $root 'docker-compose.nosql.yml'
$envFile = Join-Path $root '.env.nosql'
Set-Location -LiteralPath $root
$profileFile = Join-Path (Join-Path $root '.runtime') 'nosql-profile.json'
# Safe 16 GB laptop presets. Values are private to this PowerShell process;
# credentials and data are never rewritten when switching a resource profile.
$profiles = @{
  balanced = @{
    HAYUMERI_MONGO_LIMIT = '1536m'
    HAYUMERI_MONGO_CACHE_GB = '0.5'
    HAYUMERI_REDIS_LIMIT = '512m'
    HAYUMERI_REDIS_MAXMEMORY = '256mb'
    HAYUMERI_NEO4J_LIMIT = '2048m'
    HAYUMERI_NEO4J_HEAP = '768m'
    HAYUMERI_NEO4J_PAGECACHE = '512m'
    HAYUMERI_QDRANT_LIMIT = '2048m'
  }
  growth = @{
    HAYUMERI_MONGO_LIMIT = '2048m'
    HAYUMERI_MONGO_CACHE_GB = '0.75'
    HAYUMERI_REDIS_LIMIT = '640m'
    HAYUMERI_REDIS_MAXMEMORY = '384mb'
    HAYUMERI_NEO4J_LIMIT = '2560m'
    HAYUMERI_NEO4J_HEAP = '1024m'
    HAYUMERI_NEO4J_PAGECACHE = '768m'
    HAYUMERI_QDRANT_LIMIT = '2560m'
  }
}

function Get-ResourceProfile {
  if (-not (Test-Path -LiteralPath $profileFile -PathType Leaf)) { return 'balanced' }
  $saved = Get-Content -LiteralPath $profileFile -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($saved.schema -ne 1 -or $saved.name -notin @('balanced','growth')) {
    throw 'Неизвестный профиль NoSQL в .runtime/nosql-profile.json. Исправьте файл вручную после проверки резервной копии.'
  }
  return [string]$saved.name
}

function Set-ResourceEnvironment([string]$profileName) {
  if (-not $profiles.ContainsKey($profileName)) { throw 'Неизвестный профиль ресурсов NoSQL.' }
  foreach ($key in $profiles[$profileName].Keys) {
    [Environment]::SetEnvironmentVariable($key, [string]$profiles[$profileName][$key], 'Process')
  }
}

function Show-Resources([string]$profileName) {
  $items = $profiles[$profileName]
  Write-Host "[РЕСУРСЫ] Профиль: $profileName"
  Write-Host ("[РЕСУРСЫ] MongoDB: " + $items.HAYUMERI_MONGO_LIMIT + "; WiredTiger: " + $items.HAYUMERI_MONGO_CACHE_GB + ' GB')
  Write-Host ("[РЕСУРСЫ] Redis: " + $items.HAYUMERI_REDIS_LIMIT + "; ключи: " + $items.HAYUMERI_REDIS_MAXMEMORY + '; noeviction')
  Write-Host ("[РЕСУРСЫ] Neo4j: " + $items.HAYUMERI_NEO4J_LIMIT + "; heap: " + $items.HAYUMERI_NEO4J_HEAP + "; pagecache: " + $items.HAYUMERI_NEO4J_PAGECACHE)
  Write-Host ("[РЕСУРСЫ] Qdrant: " + $items.HAYUMERI_QDRANT_LIMIT)
  Write-Host '[РЕСУРСЫ] Docker/WSL используют дополнительную память. Дисковые тома сохраняются.'
}

function Assert-AvailableMemory([string]$profileName) {
  $raw = & $script:docker info --format '{{.MemTotal}}'
  if ($LASTEXITCODE -ne 0) { throw 'Не удалось получить объём памяти Docker Engine.' }
  [long]$bytes = 0
  if (-not [long]::TryParse(([string]$raw).Trim(), [ref]$bytes)) {
    throw 'Docker вернул некорректный объём доступной памяти.'
  }
  $gib = $bytes / 1GB
  if ($profileName -eq 'growth' -and $gib -lt 9) {
    throw ('Для профиля growth Docker/WSL должен иметь минимум 9 ГиБ памяти. Сейчас: ' + [math]::Round($gib, 1) + ' ГиБ. Увеличьте лимит WSL/Docker или используйте balanced.')
  }
  if ($profileName -eq 'balanced' -and $gib -lt 8) {
    Write-Host ('[ПРЕДУПРЕЖДЕНИЕ] Docker видит ' + [math]::Round($gib, 1) + ' ГиБ. Четырём базам рекомендуется не менее 8 ГиБ.') -ForegroundColor Yellow
  }
}

function Save-ResourceProfile([string]$profileName) {
  $parent = Split-Path -Parent $profileFile
  if (-not (Test-Path -LiteralPath $parent)) { [IO.Directory]::CreateDirectory($parent) | Out-Null }
  $temp = Join-Path $parent ('nosql-profile-' + [guid]::NewGuid().ToString('N') + '.tmp')
  try {
    @{ schema = 1; name = $profileName } | ConvertTo-Json -Compress | Set-Content -LiteralPath $temp -Encoding UTF8
    if (Test-Path -LiteralPath $profileFile) {
      $backup = Join-Path $parent 'nosql-profile.previous.json'
      Copy-Item -LiteralPath $profileFile -Destination $backup -Force
    }
    Move-Item -LiteralPath $temp -Destination $profileFile -Force
  } finally { if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force } }
}

function New-Secret {
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  $bytes = New-Object 'System.Byte[]' 32
  try { $rng.GetBytes($bytes); return [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant() }
  finally { $rng.Dispose() }
}

function Ensure-Credentials {
  if (Test-Path -LiteralPath $envFile) { return }
  $secret = @(
    '# Hayumeri local database credentials. NEVER commit or share this file.'
    ('MONGO_PASSWORD=' + (New-Secret))
    ('REDIS_PASSWORD=' + (New-Secret))
    ('NEO4J_PASSWORD=' + (New-Secret))
    ('QDRANT_API_KEY=' + (New-Secret))
  )
  # Write atomically; do not overwrite credentials on later launches.
  $temporary = Join-Path $root ('.env.nosql-' + [Guid]::NewGuid().ToString('N') + '.tmp')
  try {
    $secret | Set-Content -LiteralPath $temporary -Encoding ASCII
    if (Test-Path -LiteralPath $envFile) { throw 'Credential file appeared during creation. Not overwriting.' }
    [IO.File]::Move($temporary, $envFile)
    Write-Host '[БАЗЫ] Созданы локальные пароли в .env.nosql; файл исключён из Git.'
  } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
}

function Get-Credentials {
  if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) {
    throw 'Нет .env.nosql. Сначала выполните Hayumeri-DB.bat start.'
  }
  $items = @{}
  foreach ($line in (Get-Content -LiteralPath $envFile -Encoding ASCII)) {
    if ($line -match '^([A-Z_]+)=([A-Fa-f0-9]{64})$') { $items[$Matches[1]] = $Matches[2] }
  }
  foreach ($key in @('MONGO_PASSWORD','REDIS_PASSWORD','NEO4J_PASSWORD','QDRANT_API_KEY')) {
    if (-not $items.ContainsKey($key)) {
      throw "Файл .env.nosql неполный или содержит недопустимый ключ: $key. Не удаляйте существующие пароли с данными."
    }
  }
  return $items
}

function Assert-Docker {
  $docker = Get-Command docker.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $docker) {
    throw 'Docker Desktop не установлен. Установите и настройте Docker Desktop с Linux-контейнерами; права администратора могут понадобиться при установке.'
  }
  & $docker.Source info --format '{{.ServerVersion}}' *> $null
  if ($LASTEXITCODE -ne 0) {
    throw 'Docker Engine не работает. Запустите Docker Desktop и дождитесь готовности движка.'
  }
  & $docker.Source compose version *> $null
  if ($LASTEXITCODE -ne 0) { throw 'Не найден Docker Compose v2. Обновите Docker Desktop.' }
  return $docker.Source
}

function Invoke-Compose([string[]]$Arguments) {
  $commands = @('compose','--project-directory',$root,'--env-file',$envFile,'-f',$compose) + $Arguments
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $script:docker @commands
    $code = $LASTEXITCODE
  } finally { $ErrorActionPreference = $old }
  if ($code -ne 0) { throw "docker compose завершился с кодом $code. Проверьте свободные порты и журналы." }
}

function Test-Services($credentials) {
  $failed = 0
  Write-Host '[БАЗЫ] MongoDB — проверка авторизации...'
  try {
    Invoke-Compose -Arguments @('exec','-T','mongodb','mongosh','--quiet','-u','hayumeri','-p',$credentials['MONGO_PASSWORD'],'--authenticationDatabase','admin','--eval','db.adminCommand({ping:1}).ok')
    Write-Host '[OK] MongoDB'
  } catch { Write-Host '[ОШИБКА] MongoDB'; $failed++ }

  Write-Host '[БАЗЫ] Redis — проверка PING...'
  try {
    # Environment variable avoids redis-cli's command-line password warning.
    Invoke-Compose -Arguments @('exec','-T','-e',('REDISCLI_AUTH=' + $credentials['REDIS_PASSWORD']),'redis','redis-cli','PING')
    Write-Host '[OK] Redis'
  } catch { Write-Host '[ОШИБКА] Redis'; $failed++ }

  Write-Host '[БАЗЫ] Neo4j — проверка Cypher...'
  try {
    Invoke-Compose -Arguments @('exec','-T','neo4j','cypher-shell','-u','neo4j','-p',$credentials['NEO4J_PASSWORD'],'RETURN 1 AS ok')
    Write-Host '[OK] Neo4j'
  } catch { Write-Host '[ОШИБКА] Neo4j'; $failed++ }

  Write-Host '[БАЗЫ] Qdrant — проверка API...'
  try {
    $headers = @{ 'api-key' = $credentials['QDRANT_API_KEY'] }
    $result = Invoke-RestMethod -Uri 'http://127.0.0.1:6333/collections' -Headers $headers -TimeoutSec 8
    if ($result.status -ne 'ok') { throw 'Qdrant вернул ошибку' }
    Write-Host '[OK] Qdrant'
  } catch { Write-Host '[ОШИБКА] Qdrant'; $failed++ }
  if ($failed -gt 0) { throw "Недоступно баз: $failed. Выполните Hayumeri-DB.bat logs для диагностики." }
}

try {
  if ($Action -eq 'help') {
    Write-Host 'Hayumeri-DB.bat [start|stop|status|check|logs|stats|resources|balanced|growth]'
    exit 0
  }
  $savedProfile = Get-ResourceProfile
  if ($Action -eq 'resources') {
    Show-Resources $savedProfile
    exit 0
  }
  if (-not (Test-Path -LiteralPath $compose -PathType Leaf)) { throw 'Не найден docker-compose.nosql.yml' }
  if ($Action -eq 'start') { Ensure-Credentials }
  $credentials = Get-Credentials
  $script:docker = Assert-Docker
  $activeProfile = $savedProfile
  if ($Action -in @('balanced','growth')) { $activeProfile = $Action }
  Set-ResourceEnvironment $activeProfile
  if ($Action -in @('start','balanced','growth')) { Assert-AvailableMemory $activeProfile }
  switch ($Action) {
    'start' {
      Show-Resources $activeProfile
      Write-Host '[БАЗЫ] Загрузка и запуск MongoDB, Redis, Neo4j, Qdrant...'
      Invoke-Compose -Arguments @('up','-d')
      Write-Host '[БАЗЫ] Контейнеры запущены. Neo4j может прогреваться дольше остальных.'
      Write-Host '[БАЗЫ] Проверка: Hayumeri-DB.bat check'
      Invoke-Compose -Arguments @('ps')
    }
    'balanced' {
      Show-Resources $activeProfile
      Write-Host '[БАЗЫ] Применение сбалансированного профиля без удаления томов...'
      Invoke-Compose -Arguments @('up','-d')
      Save-ResourceProfile $activeProfile
      Write-Host '[БАЗЫ] Профиль balanced сохранён. Для диагностики: Hayumeri-DB.bat check'
      Invoke-Compose -Arguments @('ps')
    }
    'growth' {
      Show-Resources $activeProfile
      Write-Host '[БАЗЫ] Применение усиленного профиля без удаления томов...'
      Invoke-Compose -Arguments @('up','-d')
      Save-ResourceProfile $activeProfile
      Write-Host '[БАЗЫ] Профиль growth сохранён. Для диагностики: Hayumeri-DB.bat check'
      Invoke-Compose -Arguments @('ps')
    }
    'stop' {
      Write-Host '[БАЗЫ] Остановка без удаления данных...'
      Invoke-Compose -Arguments @('stop')
    }
    'status' { Show-Resources $activeProfile; Invoke-Compose -Arguments @('ps') }
    'stats' { Show-Resources $activeProfile; Invoke-Compose -Arguments @('stats','--no-stream') }
    'logs' { Invoke-Compose -Arguments @('logs','--tail','100') }
    'check' { Test-Services $credentials }
  }
  exit 0
} catch {
  Write-Host ('[ОШИБКА] ' + $_.Exception.Message) -ForegroundColor Red
  exit 1
}
