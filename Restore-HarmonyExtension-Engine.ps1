param(
    [switch]$CreateBaseline,
    [switch]$Quiet,
    [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$Message) {
    Write-Host "[Harmony Repair] $Message"
}

function Wait-IfNeeded {
    if (-not $Quiet) {
        Write-Host ''
        Read-Host 'Press Enter to close this repair window'
    }
}

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepairDir = Join-Path $Root '.harmony-repair'
$BaselineZip = Join-Path $RepairDir 'engine-baseline.zip'
$TempDir = Join-Path $RepairDir 'restore-temp'
$Timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$BackupDir = Join-Path $RepairDir "backup-before-restore-$Timestamp"

$EngineItems = @(
    'src',
    'media',
    'scripts',
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    '.vscodeignore',
    '.gitignore',
    'README.md',
    'LICENSE',
    'Restore-HarmonyExtension-Engine.ps1'
)

function Get-ExistingEnginePaths {
    $paths = @()
    foreach ($item in $EngineItems) {
        $candidate = Join-Path $Root $item
        if (Test-Path -LiteralPath $candidate) {
            $paths += $candidate
        }
    }
    return $paths
}

function New-BaselineArchive {
    New-Item -ItemType Directory -Force -Path $RepairDir | Out-Null
    if (Test-Path -LiteralPath $BaselineZip) {
        Remove-Item -LiteralPath $BaselineZip -Force
    }
    $paths = Get-ExistingEnginePaths
    if ($paths.Count -eq 0) {
        throw 'No engine files were found to baseline.'
    }
    Compress-Archive -Path $paths -DestinationPath $BaselineZip -Force
    Write-Step "Baseline archive created: $BaselineZip"
}

try {
    Set-Location $Root
    New-Item -ItemType Directory -Force -Path $RepairDir | Out-Null

    if ($CreateBaseline -or -not (Test-Path -LiteralPath $BaselineZip)) {
        New-BaselineArchive
        if ($CreateBaseline) {
            Wait-IfNeeded
            exit 0
        }
    }

    Write-Step 'Backing up current engine files before restore.'
    New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
    foreach ($item in $EngineItems) {
        $source = Join-Path $Root $item
        if (Test-Path -LiteralPath $source) {
            $destination = Join-Path $BackupDir $item
            $parent = Split-Path -Parent $destination
            New-Item -ItemType Directory -Force -Path $parent | Out-Null
            Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
        }
    }
    Write-Host "Backup folder: $BackupDir"

    if (Test-Path -LiteralPath $TempDir) {
        Remove-Item -LiteralPath $TempDir -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $TempDir | Out-Null
    Expand-Archive -LiteralPath $BaselineZip -DestinationPath $TempDir -Force

    Write-Step 'Restoring extension engine files from baseline archive.'
    foreach ($item in $EngineItems) {
        $restored = Join-Path $TempDir $item
        if (Test-Path -LiteralPath $restored) {
            $target = Join-Path $Root $item
            if (Test-Path -LiteralPath $target) {
                Remove-Item -LiteralPath $target -Recurse -Force
            }
            Copy-Item -LiteralPath $restored -Destination $target -Recurse -Force
        }
    }

    Remove-Item -LiteralPath $TempDir -Recurse -Force

    if (-not $SkipInstall) {
        Write-Step 'Compiling restored extension.'
        npm run compile
        Write-Step 'Packaging restored extension.'
        npm run package
        $Vsix = Join-Path $Root 'harmony-extension.vsix'
        if (Test-Path -LiteralPath $Vsix) {
            $CodeCmd = 'code'
            $LocalCode = Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\bin\code.cmd'
            if (Test-Path -LiteralPath $LocalCode) { $CodeCmd = $LocalCode }
            Write-Step 'Installing restored extension package.'
            & $CodeCmd --install-extension $Vsix --force
            Write-Step 'Install command finished. Reload VS Code to activate the restored extension.'
        } else {
            Write-Step "VSIX not found after packaging: $Vsix"
        }
    }

    Write-Step 'Restore complete. Chat, journals, skills, memory, and Central data were not touched.'
    Write-Host "Backup folder: $BackupDir"
    Wait-IfNeeded
}
catch {
    Write-Host ''
    Write-Host '[Harmony Repair] Restore failed:' -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    if (Test-Path -LiteralPath $BackupDir) {
        Write-Host "Backup folder: $BackupDir"
    }
    Wait-IfNeeded
    exit 1
}