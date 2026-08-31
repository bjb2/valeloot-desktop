$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'dist'
$configPath = Join-Path $root 'neutralino.config.json'
$packagePath = Join-Path $root 'package.json'
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json

if ($config.version -ne $package.version) {
    throw "Version mismatch: neutralino.config.json is $($config.version), package.json is $($package.version)."
}

$app = Join-Path $dist $config.cli.binaryName
$name = "$($config.applicationName -replace '\s+', '-')-v$($config.version)-windows-x64"
$stage = Join-Path $dist $name
$archive = Join-Path $dist "$name.zip"
$binary = Join-Path $app "$($config.cli.binaryName)-win_x64.exe"
$resources = Join-Path $app 'resources.neu'
$releaseConfig = Join-Path $app 'neutralino.config.json'
$portable = Join-Path $app '.valeloot-portable'
$extensions = Join-Path $app 'extensions'
$backend = Join-Path $extensions 'backend/index.js'
$bun = Join-Path $extensions 'bin/bun.exe'
$catalog = Join-Path $extensions 'backend/catalog.json'
$icons = Join-Path $extensions 'backend/icons'

$expectedFiles = @($binary, $resources, $releaseConfig, $portable, $backend, $catalog, $bun)
foreach ($file in $expectedFiles) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
        throw "Expected release output is missing: $file. Run 'bun run prepare && neu build --clean --release'."
    }
}

if (-not (Test-Path -LiteralPath $icons -PathType Container)) {
    throw "Expected release icon directory is missing: $icons."
}
$catalogObject = Get-Content -LiteralPath $catalog -Raw | ConvertFrom-Json
$missingIcons = @()
foreach ($entry in $catalogObject.PSObject.Properties.Value) {
    if ($null -eq $entry.icon) {
        continue
    }
    $iconName = Split-Path -Leaf ([string]$entry.icon)
    $iconPath = Join-Path $icons $iconName
    if (-not (Test-Path -LiteralPath $iconPath -PathType Leaf)) {
        $missingIcons += $iconName
    }
}
if ($missingIcons.Count -gt 0) {
    $sample = ($missingIcons | Select-Object -First 5) -join ', '
    throw "Release is missing $($missingIcons.Count) catalog icon(s): $sample"
}

$releaseConfigObject = Get-Content -LiteralPath $releaseConfig -Raw | ConvertFrom-Json
if ($releaseConfigObject.version -ne $config.version) {
    throw "Release configuration version $($releaseConfigObject.version) does not match $($config.version). Rebuild the release."
}


$sourceFiles = @(
    'package.json',
    'bun.lock',
    'tsconfig.json',
    'neutralino.config.json',
    '.valeloot-portable',
    'README.md',
    'LICENSE',
    'NOTICE',
    'SOURCE-OFFER.txt'
)
foreach ($relativePath in $sourceFiles) {
    $sourcePath = Join-Path $root $relativePath
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
        throw "Required source-distribution file is missing: $sourcePath."
    }
}

Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $stage | Out-Null

Copy-Item -LiteralPath $binary, $resources, $releaseConfig, $portable -Destination $stage
Copy-Item -LiteralPath $extensions -Destination $stage -Recurse
foreach ($legalFile in @('LICENSE', 'NOTICE', 'SOURCE-OFFER.txt')) {
    Copy-Item -LiteralPath (Join-Path $root $legalFile) -Destination $stage
}

$sourceStage = Join-Path $stage 'source'
New-Item -ItemType Directory -Path $sourceStage | Out-Null
foreach ($relativePath in $sourceFiles) {
    Copy-Item -LiteralPath (Join-Path $root $relativePath) -Destination $sourceStage
}
Copy-Item -LiteralPath (Join-Path $root 'src') -Destination $sourceStage -Recurse
Copy-Item -LiteralPath (Join-Path $root 'assets') -Destination $sourceStage -Recurse
Copy-Item -LiteralPath (Join-Path $root 'scripts') -Destination $sourceStage -Recurse
if (Test-Path -LiteralPath (Join-Path $root 'docs') -PathType Container) {
    Copy-Item -LiteralPath (Join-Path $root 'docs') -Destination $sourceStage -Recurse
}
if (Test-Path -LiteralPath (Join-Path $root 'test') -PathType Container) {
    Copy-Item -LiteralPath (Join-Path $root 'test') -Destination $sourceStage -Recurse
}

Compress-Archive -LiteralPath (Get-ChildItem -LiteralPath $stage -Force | Select-Object -ExpandProperty FullName) -DestinationPath $archive -CompressionLevel Optimal
if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) {
    throw "Archive creation failed: $archive"
}
Remove-Item -LiteralPath $stage -Recurse -Force

Write-Host "Windows release archive: $archive"
