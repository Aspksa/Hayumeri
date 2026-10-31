# Вспомогательные проверки запуска Hayumeri. Windows PowerShell 5.1+.
function Set-LaunchStatus([string] $state, [string] $message, [string] $address = '') {
    $status = [ordered]@{
        state = $state
        message = $message
        address = $address
        updatedAt = (Get-Date).ToString('o')
        processId = $PID
    }
    $file = Join-Path $runtime 'launcher-status.json'
    $temp = Join-Path $runtime ('status-' + $PID + '.tmp')
    ($status | ConvertTo-Json -Depth 4) | Set-Content -LiteralPath $temp -Encoding UTF8
    Move-Item -LiteralPath $temp -Destination $file -Force
    Write-Log "[$state] $message"
}

function Assert-Preflight {
    $required = @(
        'Hayumeri.bat', 'package.json', 'index.html', 'tsconfig.json',
        'src\main.ts', 'src\style.css', 'scripts\start.ps1',
        'scripts\launcher-helpers.ps1', 'config\launcher.json',
        'config\integrity.json'
    )
    foreach ($relative in $required) {
        $full = Join-Path $root $relative
        if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
            throw "Отсутствует обязательный файл: $relative. Скачайте полный архив проекта."
        }
    }
    $probe = Join-Path $runtime ('write-test-' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [IO.File]::WriteAllText($probe, 'ok')
    } catch {
        throw "Нет прав записи в .runtime: $($_.Exception.Message)"
    } finally {
        if (Test-Path -LiteralPath $probe) { Remove-Item -LiteralPath $probe -Force }
    }
    Write-Log '[ПРОВЕРКА] Обязательные файлы на месте. Папка доступна для записи.'
}

function Read-LauncherConfig {
    $path = Join-Path $root 'config\launcher.json'
    try {
        $config = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
    } catch {
        throw "Ошибка JSON в config\launcher.json: $($_.Exception.Message)"
    }
    $keys = @('preferredPort', 'maxPort', 'healthTimeoutSeconds', 'maxAttempts', 'openBrowser')
    foreach ($key in $keys) {
        if ($null -eq $config.PSObject.Properties[$key]) {
            throw "В конфигурации отсутствует поле: $key"
        }
    }
    foreach ($property in $config.PSObject.Properties) {
        if ($keys -notcontains $property.Name) {
            throw "Неизвестное поле настройки: $($property.Name)"
        }
    }
    foreach ($key in @('preferredPort', 'maxPort', 'healthTimeoutSeconds', 'maxAttempts')) {
        $value = $config.$key
        if (($value -isnot [int]) -and ($value -isnot [long])) {
            throw "Настройка $key должна быть целым числом."
        }
    }
    if ($config.preferredPort -lt 1024 -or $config.preferredPort -gt 65000) {
        throw 'preferredPort должен быть от 1024 до 65000.'
    }
    if ($config.maxPort -lt $config.preferredPort -or $config.maxPort -gt 65535) {
        throw 'maxPort должен быть не меньше preferredPort и не больше 65535.'
    }
    if ($config.healthTimeoutSeconds -lt 10 -or $config.healthTimeoutSeconds -gt 120) {
        throw 'healthTimeoutSeconds должен быть от 10 до 120 секунд.'
    }
    if ($config.maxAttempts -lt 1 -or $config.maxAttempts -gt 3) {
        throw 'maxAttempts должен быть от 1 до 3.'
    }
    if ($config.openBrowser -isnot [bool]) { throw 'openBrowser должен быть true или false.' }
    return $config
}

function Assert-Integrity {
    $path = Join-Path $root 'config\integrity.json'
    try {
        $manifest = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
    } catch {
        throw "Не удалось прочитать манифест целостности: $($_.Exception.Message)"
    }
    if ($manifest.schema -ne 1 -or -not $manifest.files -or $manifest.files.Count -lt 4) {
        throw 'Некорректный манифест целостности.'
    }
    $seen = @{}
    foreach ($entry in $manifest.files) {
        $relative = [string] $entry.path
        if ($relative -notmatch '^[a-zA-Z0-9][a-zA-Z0-9_\-./]*$' -or $relative.Contains('..') -or $relative.StartsWith('/')) {
            throw "Недопустимый путь в манифесте: $relative"
        }
        if ($seen.ContainsKey($relative)) { throw "Повтор файла в манифесте: $relative" }
        $seen[$relative] = $true
        if ([string]$entry.sha256 -notmatch '^[0-9a-fA-F]{64}$') {
            throw "Ошибка SHA-256 в манифесте: $relative"
        }
        $full = Join-Path $root $relative
        if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
            throw "Повреждённая установка: отсутствует $relative"
        }
        $actual = Get-Sha256 $full
        if ($actual -ne [string]$entry.sha256) {
            throw "Контрольная сумма не совпала: $relative. Необходимо восстановить файлы из доверенного архива."
        }
    }
    Write-Log "[ПРОВЕРКА] Целостность подтверждена: $($seen.Count) файлов."
}

function Test-PortAvailable([int] $port) {
    $listener = $null
    try {
        $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $port)
        $listener.Start()
        return $true
    } catch [Net.Sockets.SocketException] {
        return $false
    } finally {
        if ($listener) { $listener.Stop() }
    }
}

function Get-FreePort([int] $start, [int] $last, [hashtable] $exclude) {
    for ($candidate = $start; $candidate -le $last; $candidate++) {
        if ($exclude.ContainsKey($candidate)) { continue }
        if (Test-PortAvailable $candidate) { return $candidate }
    }
    throw "Все локальные порты в диапазоне $start–$last заняты. Измените config\launcher.json."
}

function Test-HealthySite([string] $url) {
    try {
        $response = Invoke-WebRequest -Uri $url -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
        return $response.StatusCode -eq 200 -and $response.Content.Contains('<title>Hayumeri</title>')
    } catch {
        return $false
    }
}

function Save-LaunchMetrics([hashtable] $timings, [string] $result, [string] $address = '') {
    $record = [ordered]@{
        result = $result
        address = $address
        measuredAt = (Get-Date).ToString('o')
        milliseconds = $timings
    }
    $path = Join-Path $runtime 'launch-metrics.json'
    ($record | ConvertTo-Json -Depth 5) | Set-Content -LiteralPath $path -Encoding UTF8
    foreach ($name in ($timings.Keys | Sort-Object)) {
        Write-Log ("[ВРЕМЯ] {0}: {1} мс" -f $name, $timings[$name])
    }
}

function Test-Dependencies([string] $projectRoot) {
    $files = @(
        'node_modules\vite\bin\vite.js',
        'node_modules\typescript\bin\tsc',
        'node_modules\.package-lock.json'
    )
    foreach ($relative in $files) {
        if (-not (Test-Path -LiteralPath (Join-Path $projectRoot $relative) -PathType Leaf)) {
            return $false
        }
    }
    return $true
}

function Write-ServerErrorTail([string] $stdout, [string] $stderr) {
    foreach ($path in @($stdout, $stderr)) {
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            Get-Content -LiteralPath $path -Tail 15 -ErrorAction SilentlyContinue |
                ForEach-Object { Write-Log "[СЕРВЕР] $_" }
        }
    }
}
