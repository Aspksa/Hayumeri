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
        $version = [string] (& $exe --version 2>$null | Select-Object -First 1)
        $matched = [regex]::Match($version, '^v(\d+)\.(\d+)\.(\d+)
        if (-not ($major -eq 22 -and $minor -ge 12) -and $major -ne 24 -and $major -ne 26) { return $null }
        $npm = Join-Path $directory 'npm.cmd'
        if (-not (Test-Path -LiteralPath $npm -PathType Leaf)) {
            if (-not $allowPathNpm) { return $null }
            $command = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue
            if (-not $command) { return $null }
            $npm = $command.Source
        }
        return @{ node = $exe; npm = $npm; version = $version; directory = $directory }
    } catch { return $null }
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

function Invoke-LoggedNpm([string[]] $arguments) {
    # On PowerShell 5.1, native stderr may be an ErrorRecord: don't turn
    # harmless npm warnings into terminating PowerShell exceptions.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $script:npm @arguments 2>&1 | ForEach-Object {
            $line = [string] $_
            Write-Host $line
            Add-Content -LiteralPath $log -Value $line -Encoding UTF8
        }
        return [int] $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
}

$mutex = $null
$locked = $false
$exitCode = 1
try {
    Write-Log '--- Hayumeri launch ---'
    if (-not (Test-Path -LiteralPath (Join-Path $root 'package.json') -PathType Leaf)) { throw 'Missing package.json.' }
    New-Item -ItemType Directory -Force -Path $runtime | Out-Null

    # A process-level mutex survives crashes without stale PID files.
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $pathHash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($root.ToLowerInvariant()))).Replace('-', '')
    } finally { $sha.Dispose() }
    $mutex = [System.Threading.Mutex]::new($false, ('Local\Hayumeri-' + $pathHash.Substring(0, 24)))
    try { $locked = $mutex.WaitOne(0) }
    catch [System.Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) {
        Write-Log 'Hayumeri is already starting or running from this folder. Close its original window to restart.'
        $exitCode = 0
    } else {
        $portableDir = Join-Path $runtime 'node-v24.22.2'
        $nodeInfo = Get-WorkingNode (Join-Path $runtime 'node')
        if (-not $nodeInfo) { $nodeInfo = Get-WorkingNode $portableDir }
        if (-not $nodeInfo) {
            $systemNode = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue
            if ($systemNode) {
                Write-Log "Found system node.exe: $($systemNode.Source)"
                $nodeInfo = Get-WorkingNode (Split-Path -Parent $systemNode.Source) -allowPathNpm
                if (-not $nodeInfo) { Write-Log 'System Node.js could not be paired with a supported npm.cmd.' }
            } else { Write-Log 'System Node.js not found on PATH.' }
        }
        if (-not $nodeInfo) { $nodeInfo = Install-PortableNode }

        $env:PATH = $nodeInfo.directory + ';' + $env:PATH
        $env:NPM_CONFIG_CACHE = Join-Path $runtime 'npm-cache'
        $env:NPM_CONFIG_UPDATE_NOTIFIER = 'false'
        $script:npm = $nodeInfo.npm
        Write-Log "Using Node.js $($nodeInfo.version) and npm.cmd"

        $manifest = Join-Path $root 'package.json'
        $lockfile = Join-Path $root 'package-lock.json'
        $marker = Join-Path $runtime 'installed-dependencies.sha256'
        $viteBin = Join-Path $root 'node_modules\.bin\vite.cmd'
        function Get-InstallFingerprint {
            $packageHash = (Get-Sha256 $manifest)
            $lockHash = if (Test-Path -LiteralPath $lockfile) { (Get-Sha256 $lockfile) } else { 'no-lock' }
            return "$packageHash|$lockHash|$($nodeInfo.version)"
        }
        $fingerprint = Get-InstallFingerprint
        $installedFingerprint = if (Test-Path -LiteralPath $marker) { (Get-Content -LiteralPath $marker -Raw).Trim() } else { '' }
        if (-not (Test-Path -LiteralPath $viteBin -PathType Leaf) -or $installedFingerprint -ne $fingerprint) {
            Write-Log 'Installing dependencies (first run or changed manifest/lockfile/runtime)...'
            if (Test-Path -LiteralPath $lockfile) {
                $code = Invoke-LoggedNpm -arguments @('ci', '--no-audit', '--no-fund')
            } else {
                $code = Invoke-LoggedNpm -arguments @('install', '--no-audit', '--no-fund')
            }
            if ($code -ne 0) { throw "npm installation failed (exit $code). See $log" }
            if (-not (Test-Path -LiteralPath $viteBin -PathType Leaf)) { throw 'Vite executable is missing after npm install.' }
            # npm install may have generated a lockfile. Fingerprint the final state.
            Set-Content -LiteralPath $marker -Value (Get-InstallFingerprint) -Encoding ASCII
            Write-Log 'Dependencies verified.'
        } else { Write-Log 'Dependencies unchanged; skipping installation.' }

        Write-Log 'Starting local web server at 127.0.0.1 (default port 5173).'
        Write-Log 'Vite opens the browser and chooses another port if required. Ctrl+C stops the server.'
        $code = Invoke-LoggedNpm -arguments @('run', 'dev', '--', '--host', '127.0.0.1', '--port', '5173', '--open')
        if ($code -ne 0) { throw "Web server stopped with exit code $code." }
        $exitCode = 0
    }
} catch {
    Write-Log "ERROR: $($_.Exception.Message)"
    Write-Host 'Open logs\launch.log for details.' -ForegroundColor Red
    $exitCode = 1
} finally {
    if ($locked -and $mutex) { $mutex.ReleaseMutex() }
    if ($mutex) { $mutex.Dispose() }
}
exit $exitCode
)
        if ($LASTEXITCODE -ne 0 -or -not $matched.Success) { return $null }
        $major = [int] $matched.Groups[1].Value
        $minor = [int] $matched.Groups[2].Value
        if (-not ($major -eq 22 -and $minor -ge 12) -and $major -ne 24 -and $major -ne 26) { return $null }
        $npm = Join-Path $directory 'npm.cmd'
        if (-not (Test-Path -LiteralPath $npm -PathType Leaf)) {
            if (-not $allowPathNpm) { return $null }
            $command = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue
            if (-not $command) { return $null }
            $npm = $command.Source
        }
        return @{ node = $exe; npm = $npm; version = $version; directory = $directory }
    } catch { return $null }
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
        $actual = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
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

function Invoke-LoggedNpm([string[]] $arguments) {
    # On PowerShell 5.1, native stderr may be an ErrorRecord: don't turn
    # harmless npm warnings into terminating PowerShell exceptions.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $script:npm @arguments 2>&1 | ForEach-Object {
            $line = [string] $_
            Write-Host $line
            Add-Content -LiteralPath $log -Value $line -Encoding UTF8
        }
        return [int] $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
}

$mutex = $null
$locked = $false
$exitCode = 1
try {
    Write-Log '--- Hayumeri launch ---'
    if (-not (Test-Path -LiteralPath (Join-Path $root 'package.json') -PathType Leaf)) { throw 'Missing package.json.' }
    New-Item -ItemType Directory -Force -Path $runtime | Out-Null

    # A process-level mutex survives crashes without stale PID files.
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $pathHash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($root.ToLowerInvariant()))).Replace('-', '')
    } finally { $sha.Dispose() }
    $mutex = [System.Threading.Mutex]::new($false, ('Local\Hayumeri-' + $pathHash.Substring(0, 24)))
    try { $locked = $mutex.WaitOne(0) }
    catch [System.Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) {
        Write-Log 'Hayumeri is already starting or running from this folder. Close its original window to restart.'
        $exitCode = 0
    } else {
        $portableDir = Join-Path $runtime 'node-v24.22.2'
        $nodeInfo = Get-WorkingNode (Join-Path $runtime 'node')
        if (-not $nodeInfo) { $nodeInfo = Get-WorkingNode $portableDir }
        if (-not $nodeInfo) {
            $systemNode = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue
            if ($systemNode) { $nodeInfo = Get-WorkingNode (Split-Path -Parent $systemNode.Source) -allowPathNpm }
        }
        if (-not $nodeInfo) { $nodeInfo = Install-PortableNode }

        $env:PATH = $nodeInfo.directory + ';' + $env:PATH
        $env:NPM_CONFIG_CACHE = Join-Path $runtime 'npm-cache'
        $env:NPM_CONFIG_UPDATE_NOTIFIER = 'false'
        $script:npm = $nodeInfo.npm
        Write-Log "Using Node.js $($nodeInfo.version) and npm.cmd"

        $manifest = Join-Path $root 'package.json'
        $lockfile = Join-Path $root 'package-lock.json'
        $marker = Join-Path $runtime 'installed-dependencies.sha256'
        $viteBin = Join-Path $root 'node_modules\.bin\vite.cmd'
        function Get-InstallFingerprint {
            $packageHash = (Get-FileHash -LiteralPath $manifest -Algorithm SHA256).Hash
            $lockHash = if (Test-Path -LiteralPath $lockfile) { (Get-FileHash -LiteralPath $lockfile -Algorithm SHA256).Hash } else { 'no-lock' }
            return "$packageHash|$lockHash|$($nodeInfo.version)"
        }
        $fingerprint = Get-InstallFingerprint
        $installedFingerprint = if (Test-Path -LiteralPath $marker) { (Get-Content -LiteralPath $marker -Raw).Trim() } else { '' }
        if (-not (Test-Path -LiteralPath $viteBin -PathType Leaf) -or $installedFingerprint -ne $fingerprint) {
            Write-Log 'Installing dependencies (first run or changed manifest/lockfile/runtime)...'
            if (Test-Path -LiteralPath $lockfile) {
                $code = Invoke-LoggedNpm -arguments @('ci', '--no-audit', '--no-fund')
            } else {
                $code = Invoke-LoggedNpm -arguments @('install', '--no-audit', '--no-fund')
            }
            if ($code -ne 0) { throw "npm installation failed (exit $code). See $log" }
            if (-not (Test-Path -LiteralPath $viteBin -PathType Leaf)) { throw 'Vite executable is missing after npm install.' }
            # npm install may have generated a lockfile. Fingerprint the final state.
            Set-Content -LiteralPath $marker -Value (Get-InstallFingerprint) -Encoding ASCII
            Write-Log 'Dependencies verified.'
        } else { Write-Log 'Dependencies unchanged; skipping installation.' }

        Write-Log 'Starting local web server at 127.0.0.1 (default port 5173).'
        Write-Log 'Vite opens the browser and chooses another port if required. Ctrl+C stops the server.'
        $code = Invoke-LoggedNpm -arguments @('run', 'dev', '--', '--host', '127.0.0.1', '--port', '5173', '--open')
        if ($code -ne 0) { throw "Web server stopped with exit code $code." }
        $exitCode = 0
    }
} catch {
    Write-Log "ERROR: $($_.Exception.Message)"
    Write-Host 'Open logs\launch.log for details.' -ForegroundColor Red
    $exitCode = 1
} finally {
    if ($locked -and $mutex) { $mutex.ReleaseMutex() }
    if ($mutex) { $mutex.Dispose() }
}
exit $exitCode
