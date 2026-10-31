# Hayumeri Windows launcher. Uses PowerShell 5.1 and does not require elevation.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).ProviderPath
Set-Location -LiteralPath $root
$runtime = Join-Path $root '.runtime'
$logs = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null
$log = Join-Path $logs 'launch.log'

# Rotate the launcher log to keep external drives from filling up over time.
if ((Test-Path -LiteralPath $log) -and (Get-Item -LiteralPath $log).Length -gt 4MB) {
    Move-Item -LiteralPath $log -Destination (Join-Path $logs 'launch.previous.log') -Force
}
function Write-Log([string] $message) {
    $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
    Add-Content -LiteralPath $log -Value $line -Encoding UTF8
    Write-Host $message
}

# SHA-256 via .NET also works on installations where Get-FileHash is unavailable.
function Get-Sha256([string] $path) {
    $stream = [IO.File]::OpenRead($path)
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '') }
    finally { $stream.Dispose(); $sha256.Dispose() }
}

function Get-WorkingNode([string] $directory, [switch] $allowPathNpm) {
    $exe = Join-Path $directory 'node.exe'
    if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { return $null }
    try {
        $version = [string] (& $exe --version 2>$null)
        $matched = [regex]::Match($version, '^v(\d+)\.(\d+)\.(\d+)$')
        $nodeExitCode = $LASTEXITCODE
        if ($nodeExitCode -ne 0 -or -not $matched.Success) {
            Write-Log "Node candidate rejected: $exe; version='$version'; exit=$nodeExitCode"
            return $null
        }
        $major = [int] $matched.Groups[1].Value
        $minor = [int] $matched.Groups[2].Value
        if (-not ($major -eq 22 -and $minor -ge 12) -and $major -ne 24 -and $major -ne 26) {
            Write-Log "Unsupported Node candidate: $exe; version=$version"
            return $null
        }
        $npm = Join-Path $directory 'npm.cmd'
        if (-not (Test-Path -LiteralPath $npm -PathType Leaf)) {
            if (-not $allowPathNpm) {
                Write-Log "Missing npm.cmd next to Node.js: $exe"
                return $null
            }
            $command = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue
            if (-not $command) {
                Write-Log "npm.cmd not found on PATH for $exe"
                return $null
            }
            $npm = $command.Source
        }
        return @{ node = $exe; npm = $npm; version = $version; directory = $directory }
    } catch {
        Write-Log "Node candidate check failed: $exe; $($_.Exception.Message)"
        return $null
    }
}

function Get-WithRetry([string] $uri, [string] $destination) {
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            Invoke-WebRequest -Uri $uri -OutFile $destination -UseBasicParsing -TimeoutSec 90
            return
        } catch {
            if ($attempt -eq 3) { throw "Download failed after 3 attempts ($uri): $($_.Exception.Message)" }
            Start-Sleep -Seconds (2 * $attempt)
        }
    }
}

function Install-PortableNode {
    $version = 'v24.22.2'
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' }
            elseif ([Environment]::Is64BitOperatingSystem) { 'x64' }
            else { throw '32-bit Windows is not supported. Install 64-bit Windows or use a compatible Node.js.' }
    $baseName = "node-$version-win-$arch"
    $fileName = "$baseName.zip"
    $target = Join-Path $runtime "node-$version"
    New-Item -ItemType Directory -Force -Path $runtime | Out-Null

    $existing = Get-WorkingNode $target
    if ($existing) { return $existing }
    if (Test-Path -LiteralPath $target) {
        throw "Broken portable runtime: $target. Check it or rename it before retrying."
    }
    # Unique working directory prevents a partial download from corrupting another run.
    $temporary = Join-Path $runtime ('download-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $temporary | Out-Null
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $baseUrl = "https://nodejs.org/dist/$version"
        $zip = Join-Path $temporary $fileName
        $checksums = Join-Path $temporary 'SHASUMS256.txt'
        Write-Log "Downloading official portable Node.js $version ($arch)..."
        Get-WithRetry "$baseUrl/$fileName" $zip
        Get-WithRetry "$baseUrl/SHASUMS256.txt" $checksums
        $escaped = [regex]::Escape($fileName)
        $record = Get-Content -LiteralPath $checksums -Encoding UTF8 | Where-Object { $_ -match "^([a-fA-F0-9]{64})\s+$escaped$" } | Select-Object -First 1
        if (-not $record) { throw 'Official SHA-256 record not found.' }
        $expected = ($record -split '\s+')[0].ToLowerInvariant()
        $actual = (Get-Sha256 $zip).ToLowerInvariant()
        if ($expected -ne $actual) { throw 'Portable Node.js archive SHA-256 mismatch.' }
        Write-Log 'Node.js archive SHA-256 verified.'
        $extract = Join-Path $temporary 'extracted'
        Expand-Archive -LiteralPath $zip -DestinationPath $extract
        $source = Join-Path $extract $baseName
        if (-not (Test-Path -LiteralPath (Join-Path $source 'npm.cmd') -PathType Leaf) -or
            -not (Test-Path -LiteralPath (Join-Path $source 'node.exe') -PathType Leaf)) {
            throw 'Portable Node.js archive is incomplete.'
        }
        Move-Item -LiteralPath $source -Destination $target
        $installed = Get-WorkingNode $target
        if (-not $installed) { throw "Portable Node.js failed validation: $target" }
        Write-Log 'Portable Node.js is ready.'
        return $installed
    } finally {
        Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-LoggedCommand([string] $executable, [string[]] $arguments) {
    # On PowerShell 5.1, native stderr may be an ErrorRecord: don't turn
    # harmless npm warnings into terminating PowerShell exceptions.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $executable @arguments 2>&1 | ForEach-Object {
            $line = [string] $_
            Write-Host $line
            Add-Content -LiteralPath $log -Value $line -Encoding UTF8
        }
        return [int] $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
}

# Проверки отделены от механизма скачивания Node.js.
. (Join-Path $PSScriptRoot 'launcher-helpers.ps1')
$mutex = $null
$locked = $false
$server = $null
$exitCode = 1
$metricsSaved = $false
$timings = @{}
$overall = [Diagnostics.Stopwatch]::StartNew()
try {
    Write-Log '--- Hayumeri: запуск ---'
    New-Item -ItemType Directory -Force -Path $runtime | Out-Null
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $pathHash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($root.ToLowerInvariant()))).Replace('-', '')
    } finally { $sha.Dispose() }
    $mutex = [System.Threading.Mutex]::new($false, ('Local\Hayumeri-' + $pathHash.Substring(0, 24)))
    try { $locked = $mutex.WaitOne(0) }
    catch [System.Threading.AbandonedMutexException] { $locked = $true }

    if (-not $locked) {
        Write-Log '[ПРОВЕРКА] Hayumeri уже запущена в этой папке (already starting or running).'
        $exitCode = 0
    } else {
        Set-LaunchStatus 'ПРОВЕРКА' 'Проверка файлов, настроек и целостности.'
        $phase = [Diagnostics.Stopwatch]::StartNew()
        Assert-Preflight
        $config = Read-LauncherConfig
        Assert-Integrity
        $timings['preflight'] = [int]$phase.ElapsedMilliseconds

        $phase.Restart()
        $portableDir = Join-Path $runtime 'node-v24.22.2'
        $nodeInfo = Get-WorkingNode (Join-Path $runtime 'node')
        if (-not $nodeInfo) { $nodeInfo = Get-WorkingNode $portableDir }
        if (-not $nodeInfo) {
            $systemNode = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($systemNode) {
                Write-Log "Найден Node.js: $($systemNode.Source)"
                $nodeInfo = Get-WorkingNode (Split-Path -Parent $systemNode.Source) -allowPathNpm
            }
        }
        if (-not $nodeInfo) {
            Set-LaunchStatus 'ПОДГОТОВКА' 'Загрузка портативного Node.js с проверкой SHA-256.'
            $nodeInfo = Install-PortableNode
        }
        $env:PATH = $nodeInfo.directory + ';' + $env:PATH
        $env:NPM_CONFIG_CACHE = Join-Path $runtime 'npm-cache'
        $env:NPM_CONFIG_UPDATE_NOTIFIER = 'false'
        Write-Log "[ПОДГОТОВКА] Node.js $($nodeInfo.version) доступен."

        $manifest = Join-Path $root 'package.json'
        $lockfile = Join-Path $root 'package-lock.json'
        $marker = Join-Path $runtime 'installed-dependencies.sha256'
        $viteJs = Join-Path $root 'node_modules\vite\bin\vite.js'
        function Get-InstallFingerprint {
            $packageHash = Get-Sha256 $manifest
            $lockHash = if (Test-Path -LiteralPath $lockfile) { Get-Sha256 $lockfile } else { 'no-lock' }
            return "$packageHash|$lockHash|$($nodeInfo.version)"
        }
        $fingerprint = Get-InstallFingerprint
        $installedFingerprint = if (Test-Path -LiteralPath $marker) {
            (Get-Content -LiteralPath $marker -Raw).Trim()
        } else { '' }
        $needsRepair = $installedFingerprint -ne $fingerprint -or -not (Test-Dependencies $root)
        if ($needsRepair) {
            Set-LaunchStatus 'ВОССТАНОВЛЕНИЕ' 'Проверка или восстановление зависимостей.'
            if (Test-Path -LiteralPath $lockfile) {
                $code = Invoke-LoggedCommand -executable $nodeInfo.npm -arguments @('ci', '--no-audit', '--no-fund')
            } else {
                $code = Invoke-LoggedCommand -executable $nodeInfo.npm -arguments @('install', '--no-audit', '--no-fund')
            }
            if ($code -ne 0) { throw "Установка npm завершилась с кодом $code. Смотрите logs\launch.log." }
            if (-not (Test-Dependencies $root)) { throw 'Зависимости остались неполными после установки npm.' }
            Set-Content -LiteralPath $marker -Value (Get-InstallFingerprint) -Encoding ASCII
            Write-Log '[ВОССТАНОВЛЕНИЕ] Зависимости проверены.'
        } else {
            Write-Log '[ПРОВЕРКА] Зависимости актуальны. Повторная установка не нужна.'
        }
        $timings['dependencies'] = [int]$phase.ElapsedMilliseconds

        $attempted = @{}
        for ($attempt = 1; $attempt -le $config.maxAttempts; $attempt++) {
            $port = Get-FreePort ([int]$config.preferredPort) ([int]$config.maxPort) $attempted
            $attempted[$port] = $true
            $address = "http://127.0.0.1:$port/"
            Set-LaunchStatus 'ЗАПУСК' "Запуск сайта: попытка $attempt из $($config.maxAttempts), порт $port." $address
            $stdout = Join-Path $logs ('vite-' + $PID + '-' + $attempt + '.out.log')
            $stderr = Join-Path $logs ('vite-' + $PID + '-' + $attempt + '.err.log')
            $phase.Restart()
            # node.exe запускается непосредственно: vite.cmd некорректен в путях с амперсандом.
            $args = @(('"' + $viteJs + '"'), '--host', '127.0.0.1', '--strictPort', '--port', [string]$port)
            $server = Start-Process -FilePath $nodeInfo.node -ArgumentList $args -WorkingDirectory $root -PassThru -NoNewWindow -RedirectStandardOutput $stdout -RedirectStandardError $stderr

            $ready = $false
            while ($phase.Elapsed.TotalSeconds -lt $config.healthTimeoutSeconds) {
                $server.Refresh()
                if ($server.HasExited) { break }
                if (Test-HealthySite $address) { $ready = $true; break }
                Start-Sleep -Milliseconds 400
            }
            $timings['readiness'] = [int]$phase.ElapsedMilliseconds
            if ($ready) {
                $timings['total'] = [int]$overall.ElapsedMilliseconds
                Set-LaunchStatus 'РАБОТАЕТ' "Сайт доступен: $address" $address
                Save-LaunchMetrics $timings 'ready' $address
                $metricsSaved = $true
                if ($config.openBrowser -and $env:CI -ne 'true') {
                    try { Start-Process -FilePath $address -ErrorAction Stop | Out-Null }
                    catch { Write-Log "[ПРЕДУПРЕЖДЕНИЕ] Не удалось открыть браузер. Адрес: $address" }
                }
                Write-Log '[РАБОТАЕТ] Для остановки нажмите Ctrl+C.'
                $server.WaitForExit()
                if ($server.ExitCode -ne 0) {
                    Write-ServerErrorTail $stdout $stderr
                    throw "Сервер завершился с кодом $($server.ExitCode)."
                }
                Set-LaunchStatus 'ОСТАНОВЛЕНО' 'Сервер завершил работу.'
                $exitCode = 0
                break
            }
            Write-ServerErrorTail $stdout $stderr
            if ($server -and -not $server.HasExited) {
                Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
                $server.WaitForExit(5000) | Out-Null
            }
            $server = $null
            if ($attempt -eq $config.maxAttempts) {
                throw "Сайт не ответил за $($config.healthTimeoutSeconds) секунд. Исчерпаны $($config.maxAttempts) попытки."
            }
            Write-Log "[ПОВТОР] Попытка $attempt неуспешна. Выбирается следующий порт. Максимум $($config.maxAttempts) попыток."
            Start-Sleep -Milliseconds 800
        }
    }
} catch {
    $message = $_.Exception.Message
    Write-Log "[ОШИБКА] $message"
    if ($locked) {
        try { Set-LaunchStatus 'ОШИБКА' $message } catch { Write-Host $message -ForegroundColor Red }
    }
    $exitCode = 1
} finally {
    if ($server) {
        $server.Refresh()
        if (-not $server.HasExited) {
            Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
        }
    }
    if ($locked -and -not $metricsSaved) {
        $timings['total'] = [int]$overall.ElapsedMilliseconds
        try { Save-LaunchMetrics $timings 'error' } catch { }
    }
    if ($locked -and $mutex) { $mutex.ReleaseMutex() }
    if ($mutex) { $mutex.Dispose() }
}
exit $exitCode
