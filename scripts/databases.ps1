param(
  [ValidateSet('start','stop','status','check','logs','help')]
  [string]$Action = 'start'
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).ProviderPath
$compose = Join-Path $root 'docker-compose.nosql.yml'
$envFile = Join-Path $root '.env.nosql'
Set-Location -LiteralPath $root

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
    Invoke-Compose @('exec','-T','mongodb','mongosh','--quiet','-u','hayumeri','-p',$credentials['MONGO_PASSWORD'],'--authenticationDatabase','admin','--eval','db.adminCommand({ping:1}).ok')
    Write-Host '[OK] MongoDB'
  } catch { Write-Host '[ОШИБКА] MongoDB'; $failed++ }

  Write-Host '[БАЗЫ] Redis — проверка PING...'
  try {
    # Environment variable avoids redis-cli's command-line password warning.
    Invoke-Compose @('exec','-T','-e',('REDISCLI_AUTH=' + $credentials['REDIS_PASSWORD']),'redis','redis-cli','PING')
    Write-Host '[OK] Redis'
  } catch { Write-Host '[ОШИБКА] Redis'; $failed++ }

  Write-Host '[БАЗЫ] Neo4j — проверка Cypher...'
  try {
    Invoke-Compose @('exec','-T','neo4j','cypher-shell','-u','neo4j','-p',$credentials['NEO4J_PASSWORD'],'RETURN 1 AS ok')
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
    Write-Host 'Hayumeri-DB.bat [start|stop|status|check|logs]'
    exit 0
  }
  if (-not (Test-Path -LiteralPath $compose -PathType Leaf)) { throw 'Не найден docker-compose.nosql.yml' }
  if ($Action -eq 'start') { Ensure-Credentials }
  $credentials = Get-Credentials
  $script:docker = Assert-Docker
  switch ($Action) {
    'start' {
      Write-Host '[БАЗЫ] Загрузка и запуск MongoDB, Redis, Neo4j, Qdrant...'
      Invoke-Compose @('up','-d')
      Write-Host '[БАЗЫ] Контейнеры запущены. Neo4j может прогреваться дольше остальных.'
      Write-Host '[БАЗЫ] Проверка: Hayumeri-DB.bat check'
      Invoke-Compose @('ps')
    }
    'stop' {
      Write-Host '[БАЗЫ] Остановка без удаления данных...'
      Invoke-Compose @('stop')
    }
    'status' { Invoke-Compose @('ps') }
    'logs' { Invoke-Compose @('logs','--tail','100') }
    'check' { Test-Services $credentials }
  }
  exit 0
} catch {
  Write-Host ('[ОШИБКА] ' + $_.Exception.Message) -ForegroundColor Red
  exit 1
}
