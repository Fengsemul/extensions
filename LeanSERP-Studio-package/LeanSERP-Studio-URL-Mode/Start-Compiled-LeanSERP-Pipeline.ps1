[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InputFile,

    [Parameter(Mandatory = $false)]
    [string]$CompiledOutputDirectory =
        "$env:USERPROFILE\Downloads\LeanSERP-Compiled-Output",

    [Parameter(Mandatory = $false)]
    [string]$ApprovedOutputDirectory =
        "$env:USERPROFILE\Downloads\LeanSERP-Compiled-Approved-Output",

    [Parameter(Mandatory = $false)]
    [ValidateRange(1000, 1000000)]
    [int]$ChunkSize = 500000,

    [Parameter(Mandatory = $false)]
    [switch]$KeepUnderscores,

    [Parameter(Mandatory = $false)]
    [switch]$RemoveCommonWwwLabels
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$studioDirectory =
    "C:\Users\PC\Downloads\LeanSERP-Studio-URL-Mode"

$normalizerExe = Join-Path `
    $studioDirectory `
    "bin\Release\net8.0\LeanSerpUrlNormalizer.exe"

$postprocessorExe = Join-Path `
    $studioDirectory `
    "bin\Release\net8.0\ApplyApprovedOverrides.exe"

$publicSuffixList = Join-Path `
    $studioDirectory `
    "public_suffix_list.dat"

$approvedRulesDirectory = Join-Path `
    $studioDirectory `
    "Approved-Rules"

function Get-Sha256 {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    return (
        Get-FileHash `
            -LiteralPath $Path `
            -Algorithm SHA256
    ).Hash.ToLowerInvariant()
}

foreach ($requiredFile in @(
    $InputFile,
    $normalizerExe,
    $postprocessorExe,
    $publicSuffixList
)) {
    if (-not (
        Test-Path `
            -LiteralPath $requiredFile `
            -PathType Leaf
    )) {
        throw "Required file was not found: $requiredFile"
    }
}

if (-not (
    Test-Path `
        -LiteralPath $approvedRulesDirectory `
        -PathType Container
)) {
    throw "Approved-rules directory was not found: $approvedRulesDirectory"
}

New-Item `
    -ItemType Directory `
    -Path $CompiledOutputDirectory `
    -Force |
    Out-Null

New-Item `
    -ItemType Directory `
    -Path $ApprovedOutputDirectory `
    -Force |
    Out-Null

$pipelineStarted = Get-Date
$existingCompiledBuilds = @{}

Get-ChildItem `
    -LiteralPath $CompiledOutputDirectory `
    -Directory `
    -ErrorAction SilentlyContinue |
    Where-Object {
        $_.Name -like "compiled-build-*"
    } |
    ForEach-Object {
        $existingCompiledBuilds[$_.FullName] = $true
    }

Write-Host ""
Write-Host "Starting compiled LeanSERP normalization." `
    -ForegroundColor Cyan

Write-Host "Input: $InputFile"
Write-Host "Chunk size: $ChunkSize"

$normalizerArguments = @(
    "--input",
    $InputFile,
    "--output",
    $CompiledOutputDirectory,
    "--psl",
    $publicSuffixList,
    "--chunk-size",
    [string]$ChunkSize
)

if ($KeepUnderscores) {
    $normalizerArguments += "--keep-underscores"
}

if ($RemoveCommonWwwLabels) {
    $normalizerArguments += "--remove-www"
}

& $normalizerExe @normalizerArguments

if ($LASTEXITCODE -ne 0) {
    throw "Compiled normalizer failed with exit code $LASTEXITCODE."
}

$newCompiledBuilds = @(
    Get-ChildItem `
        -LiteralPath $CompiledOutputDirectory `
        -Directory |
        Where-Object {
            $_.Name -like "compiled-build-*" -and
            -not $existingCompiledBuilds.ContainsKey($_.FullName) -and
            $_.CreationTime -ge $pipelineStarted.AddSeconds(-5)
        } |
        Sort-Object LastWriteTime -Descending
)

if ($newCompiledBuilds.Count -ne 1) {
    throw (
        "Expected exactly one new compiled build; found " +
        $newCompiledBuilds.Count +
        "."
    )
}

$compiledBuild = $newCompiledBuilds[0]
$compiledMetadataPath = Join-Path `
    $compiledBuild.FullName `
    "metadata.json"

$compiledLabelsPath = Join-Path `
    $compiledBuild.FullName `
    "labels.txt"

$compiledPslReportPath = Join-Path `
    $compiledBuild.FullName `
    "public-suffix-only.tsv"

foreach ($requiredOutput in @(
    $compiledMetadataPath,
    $compiledLabelsPath,
    $compiledPslReportPath
)) {
    if (-not (
        Test-Path `
            -LiteralPath $requiredOutput `
            -PathType Leaf
    )) {
        throw "Compiled build is incomplete: $requiredOutput"
    }
}

$compiledMetadata = Get-Content `
    -LiteralPath $compiledMetadataPath `
    -Raw |
    ConvertFrom-Json

$compiledLabelsHash = Get-Sha256 `
    -Path $compiledLabelsPath

if ($compiledLabelsHash -ne (
    [string]$compiledMetadata.LabelsSha256
).ToLowerInvariant()) {
    throw "The compiled labels failed SHA-256 verification."
}

Write-Host ""
Write-Host "Compiled normalization completed and verified." `
    -ForegroundColor Green

Write-Host "Build: $($compiledBuild.FullName)"
Write-Host "Labels: $($compiledMetadata.UniqueLabels)"
Write-Host "SHA-256: $compiledLabelsHash"

$existingApprovedBuilds = @{}

Get-ChildItem `
    -LiteralPath $ApprovedOutputDirectory `
    -Directory `
    -ErrorAction SilentlyContinue |
    Where-Object {
        $_.Name -like "approved-build-*"
    } |
    ForEach-Object {
        $existingApprovedBuilds[$_.FullName] = $true
    }

Write-Host ""
Write-Host "Applying approved rules." `
    -ForegroundColor Cyan

& $postprocessorExe `
    --input-build $compiledBuild.FullName `
    --approved-rules $approvedRulesDirectory `
    --output $ApprovedOutputDirectory

if ($LASTEXITCODE -ne 0) {
    throw (
        "Approved-rule postprocessor failed with exit code " +
        $LASTEXITCODE +
        "."
    )
}

$newApprovedBuilds = @(
    Get-ChildItem `
        -LiteralPath $ApprovedOutputDirectory `
        -Directory |
        Where-Object {
            $_.Name -like "approved-build-*" -and
            -not $existingApprovedBuilds.ContainsKey($_.FullName) -and
            $_.CreationTime -ge $pipelineStarted.AddSeconds(-5)
        } |
        Sort-Object LastWriteTime -Descending
)

if ($newApprovedBuilds.Count -ne 1) {
    throw (
        "Expected exactly one new approved build; found " +
        $newApprovedBuilds.Count +
        "."
    )
}

$approvedBuild = $newApprovedBuilds[0]

$approvedLabelsPath = Join-Path `
    $approvedBuild.FullName `
    "labels.txt"

$approvedOverridesPath = Join-Path `
    $approvedBuild.FullName `
    "psl-label-overrides.txt"

$approvedExactHostsPath = Join-Path `
    $approvedBuild.FullName `
    "exact-host-blocks.txt"

$approvedReportPath = Join-Path `
    $approvedBuild.FullName `
    "approved-overrides-report.json"

foreach ($requiredOutput in @(
    $approvedLabelsPath,
    $approvedOverridesPath,
    $approvedExactHostsPath,
    $approvedReportPath
)) {
    if (-not (
        Test-Path `
            -LiteralPath $requiredOutput `
            -PathType Leaf
    )) {
        throw "Approved build is incomplete: $requiredOutput"
    }
}

$approvedReport = Get-Content `
    -LiteralPath $approvedReportPath `
    -Raw |
    ConvertFrom-Json

$approvedLabelsHash = Get-Sha256 `
    -Path $approvedLabelsPath

$approvedOverridesHash = Get-Sha256 `
    -Path $approvedOverridesPath

$approvedExactHostsHash = Get-Sha256 `
    -Path $approvedExactHostsPath

if ($approvedLabelsHash -ne (
    [string]$approvedReport.LabelsSha256
).ToLowerInvariant()) {
    throw "Approved labels failed SHA-256 verification."
}

if ($approvedOverridesHash -ne (
    [string]$approvedReport.OverridesSha256
).ToLowerInvariant()) {
    throw "Approved PSL overrides failed SHA-256 verification."
}

if ($approvedExactHostsHash -ne (
    [string]$approvedReport.ExactHostsSha256
).ToLowerInvariant()) {
    throw "Approved exact hosts failed SHA-256 verification."
}

$pipelineFinished = Get-Date
$durationSeconds = [math]::Round(
    ($pipelineFinished - $pipelineStarted).TotalSeconds,
    3
)

Write-Host ""
Write-Host "Compiled LeanSERP pipeline completed." `
    -ForegroundColor Green

[pscustomobject]@{
    InputFile = (Resolve-Path -LiteralPath $InputFile).Path
    CompiledBuild = $compiledBuild.FullName
    ApprovedBuild = $approvedBuild.FullName
    InputLines = $compiledMetadata.InputLines
    CompiledLabels = $compiledMetadata.UniqueLabels
    FinalLabels = $approvedReport.FinalLabelCount
    LabelsAddedByOverrides = $approvedReport.AddedLabelCount
    UsedPslOverrides = $approvedReport.UsedOverrideCount
    UsedExactHosts = $approvedReport.UsedExactHostCount
    LabelsSha256 = $approvedLabelsHash
    DurationSeconds = $durationSeconds
    Verified = $true
} |
    Format-List