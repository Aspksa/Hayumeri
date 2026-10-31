# Hayumeri Windows launcher. Requires PowerShell 5.1+.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
$logs = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null
$log = Join-Path $logs 'launch.log'

function Write-Log([string] $message) {
    $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
    Add-Content -LiteralPath $log -Value $line -Encoding UTF8
    Write-Host $message
}

function Test-Node([string] $executable) {
    if (-not $executable -or -not (Test-Path -LiteralPath $executable)) { return $false }
    try {
        $versionText = (& $executable --version 2>$null | Select-Object -First 1)
        if ($LASTEXITCODE -ne 0 -or $versionText -notmatch '^v(\d+)\.(\d+)\.(\d+)$') { return $false }
        $major = [int] $Matches[1]
        $minor = [int] $Matches[2]
        return ($major -gt 22 -or ($major -eq 22 -and $minor -ge 12) -or ($major -eq 20 -and $minor -ge 19))
    } catch { return $false }
}

function Install-PortableNode {
    $version = 'v22.16.0'
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' }
            elseif ([Environment]::Is64BitOperatingSystem) { 'x64' }
            else { throw '32-bit Windows is not supported by this starter.' }
    $baseName = "node-$version-win-$arch"
    $fileName = "$baseName.zip"
    $runtime = Join-Path $root '.runtime'
    $target = Join-Path $runtime "node-$version"
    $temporary = Join-Path $runtime 'node-download'
    New-Item -ItemType Directory -Force -Path $runtime | Out-Null

    if (Test-Node (Join-Path $target 'node.exe')) { return $target }
    if (Test-Path -LiteralPath $target) {
        throw "Portable Node directory exists but is invalid: $target. Check it manually."
    }
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force }
    New-Item -ItemType Directory -Path $temporary | Out-Null

    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $baseUrl = "https://nodejs.org/dist/$version"
        $zip = Join-Path $temporary $fileName
        $checksums = Join-Path $temporary 'SHASUMS256.txt'
        Write-Log "Downloading portable Node.js $version ($arch) from nodejs.org..."
        Invoke-WebRequest -Uri "$baseUrl/$fileName" -OutFile $zip -UseBasicParsing
        Invoke-WebRequest -Uri "$baseUrl/SHASUMS256.txt" -OutFile $checksums -UseBasicParsing
        $record = Get-Content -LiteralPath $checksums | Where-Object { $_.EndsWith("  $fileName") } | Select-Object -First 1
        if (-not $record) { throw 'Official SHA-256 checksum is missing.' }
        $expected = ($record -split '\s+')[0].ToLowerInvariant()
        $actual = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($expected -ne $actual) { throw 'Node.js archive SHA-256 verification failed.' }
        Write-Log 'SHA-256 verified.'
        $extract = Join-Path $temporary 'extracted'
        Expand-Archive -LiteralPath $zip -DestinationPath $extract
        $source = Join-Path $extract $baseName
        if (-not (Test-Path -LiteralPath (Join-Path $source 'node.exe'))) { throw 'Invalid Node.js archive structure.' }
        Move-Item -LiteralPath $source -Destination $target
        if (-not (Test-Node (Join-Path $target 'node.exe'))) { throw 'Downloaded Node.js could not be started.' }
        Write-Log 'Portable Node.js is ready.'
        return $target
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

try {
    Write-Log '--- Hayumeri launch ---'
    if (-not (Test-Path -LiteralPath (Join-Path $root 'package.json'))) { throw 'Missing package.json.' }

    $runtime = Join-Path $root '.runtime'
    $nodeDir = Join-Path $runtime 'node'
    $node = Join-Path $nodeDir 'node.exe'

    if (-not (Test-Node $node)) {
        $portable = Join-Path $runtime 'node-v22.16.0'
        $nodeDir = $portable
        $node = Join-Path $portable 'node.exe'
    }
    if (-not (Test-Node $node)) {
        $systemNode = Get-Command node.exe -ErrorAction SilentlyContinue
        if ($systemNode -and (Test-Node $systemNode.Source)) {
            $node = $systemNode.Source
            $nodeDir = Split-Path -Parent $node
        } else {
            $nodeDir = Install-PortableNode
            $node = Join-Path $nodeDir 'node.exe'
        }
    }
    $env:PATH = "$nodeDir;$env:PATH"
    $npm = Join-Path $nodeDir 'npm.cmd'
    if (-not (Test-Path -LiteralPath $npm)) {
        $systemNpm = Get-Command npm.cmd -ErrorAction SilentlyContinue
        if (-not $systemNpm) { throw 'npm.cmd is missing. Provide a complete Node.js distribution.' }
        $npm = $systemNpm.Source
    }
    Write-Log "Using Node.js $(& $node --version)"

    # Install only when needed, with versioned lockfile support.
    $packageHash = (Get-FileHash -LiteralPath (Join-Path $root 'package.json') -Algorithm SHA256).Hash
    $marker = Join-Path $runtime 'installed-package.sha256'
    $viteBin = Join-Path $root 'node_modules\.bin\vite.cmd'
    $installedHash = if (Test-Path -LiteralPath $marker) { (Get-Content -LiteralPath $marker -Raw).Trim() } else { '' }
    if (-not (Test-Path -LiteralPath $viteBin) -or $installedHash -ne $packageHash) {
        Write-Log 'Installing or refreshing project dependencies...'
        if (Test-Path -LiteralPath (Join-Path $root 'package-lock.json')) {
            & $npm ci --no-audit --no-fund
        } else {
            & $npm install --no-audit --no-fund
        }
        if ($LASTEXITCODE -ne 0) { throw "npm dependency installation failed (exit $LASTEXITCODE)." }
        New-Item -ItemType Directory -Force -Path $runtime | Out-Null
        Set-Content -LiteralPath $marker -Value $packageHash -Encoding ASCII
        Write-Log 'Dependencies are ready.'
    }

    Write-Log 'Starting the web application. To stop it, press Ctrl+C.'
    Write-Log 'Vite will open the browser and choose the next free port if necessary.'
    & $npm run dev -- --host 127.0.0.1 --port 5173 --open
    if ($LASTEXITCODE -ne 0) { throw "Web server stopped with exit code $LASTEXITCODE." }
    exit 0
} catch {
    Write-Log "ERROR: $($_.Exception.Message)"
    Write-Host 'See logs\launch.log for launch diagnostics.' -ForegroundColor Red
    exit 1
}
