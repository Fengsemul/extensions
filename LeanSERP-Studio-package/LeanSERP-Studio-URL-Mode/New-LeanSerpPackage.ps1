[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ApprovedBuild,

    [Parameter(Mandatory = $false)]
    [string]$HostSubdomainBlocks = "",

    [Parameter(Mandatory = $false)]
    [string]$PslHostCandidates = "",

    [Parameter(Mandatory = $false)]
    [string]$RejectedLines = "",

    [Parameter(Mandatory = $false)]
    [string]$OutputDirectory = "$env:USERPROFILE\Downloads\LeanSERP-Packages"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$FormatName = "leanserp-package"
$FormatVersion = 1
$Encoding = [System.Text.UTF8Encoding]::new($false)

function Get-Sha256 {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-LineCount {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $reader = [System.IO.StreamReader]::new(
        $Path,
        [System.Text.UTF8Encoding]::new($false),
        $true,
        1048576
    )

    $count = [long]0

    try {
        while ($null -ne $reader.ReadLine()) {
            $count++
        }
    }
    finally {
        $reader.Dispose()
    }

    return $count
}

function Test-SortedUniqueFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [string]$Description
    )

    $reader = [System.IO.StreamReader]::new(
        $Path,
        [System.Text.UTF8Encoding]::new($false),
        $true,
        1048576
    )

    $lineNumber = [long]0
    $previous = $null

    try {
        while ($null -ne ($line = $reader.ReadLine())) {
            $lineNumber++

            if ([string]::IsNullOrWhiteSpace($line)) {
                throw "$Description contains an empty line at line $lineNumber."
            }

            if ($null -ne $previous) {
                $comparison = [string]::CompareOrdinal($previous, $line)

                if ($comparison -eq 0) {
                    throw "$Description contains a duplicate at line $lineNumber`: $line"
                }

                if ($comparison -gt 0) {
                    throw "$Description is not ordinally sorted at line $lineNumber`: $line"
                }
            }

            $previous = $line
        }
    }
    finally {
        $reader.Dispose()
    }
}

function Copy-VerifiedFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Source,

        [Parameter(Mandatory = $true)]
        [string]$Destination
    )

    if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
        throw "Source file was not found: $Source"
    }

    Copy-Item -LiteralPath $Source -Destination $Destination -Force

    $sourceHash = Get-Sha256 -Path $Source
    $destinationHash = Get-Sha256 -Path $Destination

    if ($sourceHash -ne $destinationHash) {
        throw "Copy verification failed: $Destination"
    }
}

function New-EmptyUtf8File {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    [System.IO.File]::WriteAllText($Path, "", $Encoding)
}

if (-not (Test-Path -LiteralPath $ApprovedBuild -PathType Container)) {
    throw "Approved build directory was not found: $ApprovedBuild"
}

$approvedLabels = Join-Path $ApprovedBuild "labels.txt"
$approvedExactHosts = Join-Path $ApprovedBuild "exact-host-blocks.txt"
$approvedOverrides = Join-Path $ApprovedBuild "psl-label-overrides.txt"
$approvedReport = Join-Path $ApprovedBuild "approved-overrides-report.json"

foreach ($path in @(
    $approvedLabels,
    $approvedExactHosts,
    $approvedOverrides,
    $approvedReport
)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Required approved-build file is missing: $path"
    }
}

$report = Get-Content -LiteralPath $approvedReport -Raw | ConvertFrom-Json

$approvedLabelsHash = Get-Sha256 -Path $approvedLabels
$approvedExactHostsHash = Get-Sha256 -Path $approvedExactHosts
$approvedOverridesHash = Get-Sha256 -Path $approvedOverrides

if ($approvedLabelsHash -ne ([string]$report.LabelsSha256).ToLowerInvariant()) {
    throw "The source labels.txt failed its recorded SHA-256 verification."
}

if ($approvedExactHostsHash -ne ([string]$report.ExactHostsSha256).ToLowerInvariant()) {
    throw "The source exact-host-blocks.txt failed its recorded SHA-256 verification."
}

if ($approvedOverridesHash -ne ([string]$report.OverridesSha256).ToLowerInvariant()) {
    throw "The source psl-label-overrides.txt failed its recorded SHA-256 verification."
}

Test-SortedUniqueFile -Path $approvedLabels -Description "labels.txt"
Test-SortedUniqueFile -Path $approvedExactHosts -Description "exact-host-blocks.txt"
Test-SortedUniqueFile -Path $approvedOverrides -Description "psl-label-overrides.txt"

$labelsCount = Get-LineCount -Path $approvedLabels
$exactHostsCount = Get-LineCount -Path $approvedExactHosts
$overridesCount = Get-LineCount -Path $approvedOverrides

if ($labelsCount -ne [long]$report.FinalLabelCount) {
    throw "Source label count differs from the approved report."
}

if ($exactHostsCount -ne [long]$report.UsedExactHostCount) {
    throw "Source exact-host count differs from the approved report."
}

if ($overridesCount -ne [long]$report.UsedOverrideCount) {
    throw "Source override count differs from the approved report."
}

[void](New-Item -ItemType Directory -Path $OutputDirectory -Force)

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$packageDirectory = Join-Path $OutputDirectory ("LeanSERP-Package-" + $timestamp)
[void](New-Item -ItemType Directory -Path $packageDirectory -Force)

$labelsDestination = Join-Path $packageDirectory "labels.txt"
$exactHostsDestination = Join-Path $packageDirectory "exact-host-blocks.txt"
$hostSubdomainsDestination = Join-Path $packageDirectory "host-subdomain-blocks.txt"
$overridesDestination = Join-Path $packageDirectory "psl-label-overrides.txt"
$pslCandidatesDestination = Join-Path $packageDirectory "psl-host-candidates.txt"
$rejectedDestination = Join-Path $packageDirectory "rejected-lines.tsv"
$manifestDestination = Join-Path $packageDirectory "metadata.json"

Copy-VerifiedFile -Source $approvedLabels -Destination $labelsDestination
Copy-VerifiedFile -Source $approvedExactHosts -Destination $exactHostsDestination
Copy-VerifiedFile -Source $approvedOverrides -Destination $overridesDestination

if (-not [string]::IsNullOrWhiteSpace($HostSubdomainBlocks)) {
    Copy-VerifiedFile -Source $HostSubdomainBlocks -Destination $hostSubdomainsDestination
    Test-SortedUniqueFile -Path $hostSubdomainsDestination -Description "host-subdomain-blocks.txt"
}
else {
    New-EmptyUtf8File -Path $hostSubdomainsDestination
}

if (-not [string]::IsNullOrWhiteSpace($PslHostCandidates)) {
    Copy-VerifiedFile -Source $PslHostCandidates -Destination $pslCandidatesDestination
    Test-SortedUniqueFile -Path $pslCandidatesDestination -Description "psl-host-candidates.txt"
}
else {
    New-EmptyUtf8File -Path $pslCandidatesDestination
}

if (-not [string]::IsNullOrWhiteSpace($RejectedLines)) {
    Copy-VerifiedFile -Source $RejectedLines -Destination $rejectedDestination
}
else {
    New-EmptyUtf8File -Path $rejectedDestination
}

$fileNames = @(
    "labels.txt",
    "exact-host-blocks.txt",
    "host-subdomain-blocks.txt",
    "psl-label-overrides.txt",
    "psl-host-candidates.txt",
    "rejected-lines.tsv"
)

$filesMetadata = [ordered]@{}

foreach ($name in $fileNames) {
    $path = Join-Path $packageDirectory $name

    $role = switch ($name) {
        "labels.txt" { "active-label-blocks" }
        "exact-host-blocks.txt" { "active-exact-host-blocks" }
        "host-subdomain-blocks.txt" { "active-host-subdomain-blocks" }
        "psl-label-overrides.txt" { "active-psl-label-overrides" }
        "psl-host-candidates.txt" { "review-only-psl-host-candidates" }
        "rejected-lines.tsv" { "diagnostic-rejections" }
    }

    $importByFilter = $name -in @(
        "labels.txt",
        "exact-host-blocks.txt",
        "host-subdomain-blocks.txt",
        "psl-label-overrides.txt"
    )

    $filesMetadata[$name] = [ordered]@{
        role = $role
        importByFilter = $importByFilter
        count = Get-LineCount -Path $path
        byteLength = (Get-Item -LiteralPath $path).Length
        sha256 = Get-Sha256 -Path $path
    }
}

$manifest = [ordered]@{
    format = $FormatName
    version = $FormatVersion
    createdAt = [DateTimeOffset]::UtcNow.ToString("o")
    encoding = "utf-8"
    sorting = "ordinal"
    packageDirectoryName = Split-Path $packageDirectory -Leaf
    sourceApprovedBuild = (Resolve-Path -LiteralPath $ApprovedBuild).Path
    activationPolicy = [ordered]@{
        atomicImportRequired = $true
        verifyEveryFileBeforeActivation = $true
        candidateFilesAreReviewOnly = $true
        retainPreviousGenerationUntilSuccess = $true
    }
    precedence = @(
        "exact-host-allow",
        "label-allow",
        "exact-host-block",
        "host-subdomain-block",
        "psl-label-override",
        "public-suffix-exclusion",
        "blocked-label"
    )
    files = $filesMetadata
}

$manifestJson = $manifest | ConvertTo-Json -Depth 12
[System.IO.File]::WriteAllText(
    $manifestDestination,
    $manifestJson + [Environment]::NewLine,
    $Encoding
)

$manifestHash = Get-Sha256 -Path $manifestDestination

Write-Host ""
Write-Host "Unified LeanSERP package created." -ForegroundColor Green
Write-Host "Package: $packageDirectory" -ForegroundColor Green
Write-Host "Labels: $labelsCount"
Write-Host "Exact-host blocks: $exactHostsCount"
Write-Host "Host-subdomain blocks: $($filesMetadata['host-subdomain-blocks.txt'].count)"
Write-Host "PSL label overrides: $overridesCount"
Write-Host "PSL host candidates: $($filesMetadata['psl-host-candidates.txt'].count)"
Write-Host "Manifest SHA-256: $manifestHash"
