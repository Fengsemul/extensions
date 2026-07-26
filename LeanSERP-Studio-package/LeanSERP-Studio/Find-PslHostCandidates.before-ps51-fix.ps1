[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InputFile,

    [Parameter(Mandatory = $false)]
    [string]$PublicSuffixList =
        "$PSScriptRoot\public_suffix_list.dat",

    [Parameter(Mandatory = $false)]
    [string]$OutputDirectory =
        "$env:USERPROFILE\Downloads\LeanSERP-PSL-Candidates"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function New-Utf8Writer {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    return [System.IO.StreamWriter]::new(
        $Path,
        $false,
        [System.Text.UTF8Encoding]::new($false),
        1048576
    )
}

function Remove-BomArtifacts {
    param(
        [AllowEmptyString()]
        [string]$Value
    )

    $text = [string]$Value
    $text = $text.TrimStart([char]0xFEFF)

    $mojibakeBom = [string]::Concat(
        [char]0x00EF,
        [char]0x00BB,
        [char]0x00BF
    )

    $replacementBom = [string]::Concat(
        [char]0x00EF,
        [char]0x00BF,
        [char]0x00BD
    )

    while ($text.StartsWith($mojibakeBom)) {
        $text = $text.Substring(
            $mojibakeBom.Length
        )
    }

    while ($text.StartsWith($replacementBom)) {
        $text = $text.Substring(
            $replacementBom.Length
        )
    }

    return $text
}

function ConvertTo-NormalizedHostname {
    param(
        [AllowEmptyString()]
        [string]$Line
    )

    if ($null -eq $Line) {
        return ""
    }

    $value = Remove-BomArtifacts -Value $Line
    $value = $value.Trim()

    if (
        [string]::IsNullOrWhiteSpace($value) -or
        $value.StartsWith("#") -or
        $value.StartsWith("!") -or
        $value.Contains([char]0)
    ) {
        return ""
    }

    $fields = $value -split "\s+"

    if (
        $fields.Count -ge 2 -and
        $fields[0] -match
            "^(?:0\.0\.0\.0|127\.0\.0\.1|::1)$"
    ) {
        $value = $fields[1]
    }
    else {
        $value = $fields[0]
    }

    if (
        [string]::IsNullOrWhiteSpace($value) -or
        $value.StartsWith("@@")
    ) {
        return ""
    }

    $value = $value.ToLowerInvariant()

    if ($value.StartsWith("*://*.")) {
        $value = $value.Substring(6)
    }
    elseif ($value.StartsWith("*://")) {
        $value = $value.Substring(4)

        if ($value.StartsWith("*.")) {
            $value = $value.Substring(2)
        }
    }
    elseif (
        $value -match
        "^[a-z][a-z0-9+.-]*://"
    ) {
        try {
            $uri = [System.Uri]$value
            $value = $uri.DnsSafeHost
        }
        catch {
            return ""
        }
    }

    $value = Remove-BomArtifacts -Value $value
    $value = $value -replace "[/?#].*$", ""
    $value = $value.Trim(".")
    $value = $value.ToLowerInvariant()

    if ($value.StartsWith("www.")) {
        $value = $value.Substring(4)
    }

    if (
        [string]::IsNullOrWhiteSpace($value) -or
        $value.Length -gt 253 -or
        $value.Contains(":") -or
        -not $value.Contains(".")
    ) {
        return ""
    }

    try {
        $idn =
            [System.Globalization.IdnMapping]::new()

        $asciiLabels =
            [System.Collections.Generic.List[string]]::new()

        foreach ($label in ($value -split "\.")) {
            if (
                [string]::IsNullOrWhiteSpace($label)
            ) {
                return ""
            }

            $asciiLabel = $idn
                .GetAscii($label)
                .ToLowerInvariant()

            if (
                $asciiLabel.Length -lt 1 -or
                $asciiLabel.Length -gt 63 -or
                $asciiLabel -notmatch
                    "^[a-z0-9_-]+$" -or
                $asciiLabel.StartsWith("-") -or
                $asciiLabel.EndsWith("-")
            ) {
                return ""
            }

            $asciiLabels.Add($asciiLabel)
        }

        $value = $asciiLabels -join "."
    }
    catch {
        return ""
    }

    return $value
}

function Import-MultiLabelPublicSuffixes {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $suffixes =
        [System.Collections.Generic.HashSet[string]]::new(
            [System.StringComparer]::OrdinalIgnoreCase
        )

    $reader = [System.IO.StreamReader]::new(
        $Path,
        [System.Text.UTF8Encoding]::new($false),
        $true,
        1048576
    )

    try {
        while (-not $reader.EndOfStream) {
            $line = $reader.ReadLine()

            if ($null -eq $line) {
                continue
            }

            $line = $line.Trim()

            if (
                -not $line -or
                $line.StartsWith("//") -or
                $line.StartsWith("!") -or
                $line.StartsWith("*.")
            ) {
                continue
            }

            $commentIndex =
                $line.IndexOf(" //")

            if ($commentIndex -ge 0) {
                $line = $line
                    .Substring(0, $commentIndex)
                    .Trim()
            }

            if (
                $line.Contains(".") -and
                $line -match
                    "^[a-zA-Z0-9._-]+$"
            ) {
                [void]$suffixes.Add(
                    $line.ToLowerInvariant()
                )
            }
        }
    }
    finally {
        $reader.Dispose()
    }

    if (
        $suffixes.Count -lt 100 -or
        -not $suffixes.Contains("co.uk")
    ) {
        throw (
            "The multi-label Public Suffix List " +
            "failed validation."
        )
    }

    return $suffixes
}

if (
    -not (
        Test-Path `
            -LiteralPath $InputFile `
            -PathType Leaf
    )
) {
    throw "Input file was not found: $InputFile"
}

if (
    -not (
        Test-Path `
            -LiteralPath $PublicSuffixList `
            -PathType Leaf
    )
) {
    throw (
        "Public Suffix List was not found: " +
        $PublicSuffixList
    )
}

New-Item `
    -ItemType Directory `
    -Path $OutputDirectory `
    -Force |
    Out-Null

Write-Host "Loading multi-label Public Suffix rules..."

$publicSuffixes =
    Import-MultiLabelPublicSuffixes `
        -Path $PublicSuffixList

Write-Host (
    "Loaded {0:N0} multi-label suffix rules." -f
    $publicSuffixes.Count
)

$timestamp =
    Get-Date -Format "yyyyMMdd-HHmmss"

$candidatePath = Join-Path `
    $OutputDirectory `
    "psl-host-candidates-$timestamp.txt"

$detailPath = Join-Path `
    $OutputDirectory `
    "psl-host-candidate-details-$timestamp.tsv"

$rejectedPath = Join-Path `
    $OutputDirectory `
    "psl-scan-rejected-$timestamp.tsv"

$metadataPath = Join-Path `
    $OutputDirectory `
    "psl-host-candidates-$timestamp.meta.json"

$candidates =
    [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
    )

$reader = [System.IO.StreamReader]::new(
    $InputFile,
    [System.Text.UTF8Encoding]::new($false),
    $true,
    1048576
)

$rejectedWriter =
    New-Utf8Writer -Path $rejectedPath

$totalLines = [long]0
$validHostnames = [long]0
$rejectedLines = [long]0
$candidateOccurrences = [long]0
$startedAt = [DateTimeOffset]::UtcNow

try {
    while (-not $reader.EndOfStream) {
        $line = $reader.ReadLine()
        $totalLines++

        $hostname =
            ConvertTo-NormalizedHostname `
                -Line $line

        if (-not $hostname) {
            $rejectedLines++

            if ($rejectedLines -le 10000) {
                $rejectedWriter.WriteLine(
                    [string]::Join(
                        "`t",
                        @(
                            "invalid-hostname",
                            [string]$totalLines,
                            [string]$line
                        )
                    )
                )
            }

            continue
        }

        $validHostnames++

        if (
            $publicSuffixes.Contains(
                $hostname
            )
        ) {
            $candidateOccurrences++
            [void]$candidates.Add(
                $hostname
            )
        }

        if (
            $totalLines % 1000000 -eq 0
        ) {
            Write-Host (
                "Scanned {0:N0} lines; " +
                "{1:N0} unique candidates." -f
                $totalLines,
                $candidates.Count
            )
        }
    }
}
finally {
    $reader.Dispose()
    $rejectedWriter.Dispose()
}

$sortedCandidates =
    [string[]]$candidates

[Array]::Sort(
    $sortedCandidates,
    [System.StringComparer]::Ordinal
)

$candidateWriter =
    New-Utf8Writer -Path $candidatePath

$detailWriter =
    New-Utf8Writer -Path $detailPath

try {
    $detailWriter.WriteLine(
        [string]::Join(
            "`t",
            @(
                "hostname",
                "firstLabel",
                "labelCount",
                "suggestedExactHostRule",
                "suggestedPslOverrideLabel",
                "networkStatus"
            )
        )
    )

    foreach (
        $candidate in
            $sortedCandidates
    ) {
        $labels = @(
            $candidate -split "\."
        )

        $firstLabel = $labels[0]

        $candidateWriter.WriteLine(
            $candidate
        )

        $detailWriter.WriteLine(
            [string]::Join(
                "`t",
                @(
                    $candidate,
                    $firstLabel,
                    [string]$labels.Count,
                    $candidate,
                    $firstLabel,
                    "not-tested"
                )
            )
        )
    }
}
finally {
    $candidateWriter.Dispose()
    $detailWriter.Dispose()
}

$finishedAt = [DateTimeOffset]::UtcNow

$candidateHash = (
    Get-FileHash `
        -LiteralPath $candidatePath `
        -Algorithm SHA256
).Hash.ToLowerInvariant()

$metadata = [ordered]@{
    format =
        "leanserp-psl-host-candidates"
    version = 1
    createdAt =
        $finishedAt.ToString("o")
    durationSeconds = [math]::Round(
        (
            $finishedAt -
            $startedAt
        ).TotalSeconds,
        3
    )
    inputFile = (
        Resolve-Path `
            -LiteralPath $InputFile
    ).Path
    inputByteLength = (
        Get-Item `
            -LiteralPath $InputFile
    ).Length
    inputLineCount = $totalLines
    validHostnameCount =
        $validHostnames
    rejectedLineCount =
        $rejectedLines
    publicSuffixRuleCount =
        $publicSuffixes.Count
    candidateOccurrences =
        $candidateOccurrences
    uniqueCandidateCount =
        $candidates.Count
    candidateSha256 =
        $candidateHash
    networkTestsPerformed =
        $false
}

$metadataJson =
    $metadata |
    ConvertTo-Json -Depth 8

[System.IO.File]::WriteAllText(
    $metadataPath,
    $metadataJson +
        [Environment]::NewLine,
    [System.Text.UTF8Encoding]::new(
        $false
    )
)

Write-Host ""
Write-Host (
    "PSL-host candidate scan completed."
) -ForegroundColor Green

Write-Host (
    "Input lines: {0:N0}" -f
    $totalLines
)

Write-Host (
    "Valid hostnames: {0:N0}" -f
    $validHostnames
)

Write-Host (
    "Rejected lines: {0:N0}" -f
    $rejectedLines
)

Write-Host (
    "Unique PSL-host candidates: {0:N0}" -f
    $candidates.Count
) -ForegroundColor Green

Write-Host ""
Write-Host "Candidates:"
Write-Host $candidatePath
Write-Host "Candidate details:"
Write-Host $detailPath
Write-Host "Rejected-input report:"
Write-Host $rejectedPath
Write-Host "Metadata:"
Write-Host $metadataPath
Write-Host "Candidate SHA-256:"
Write-Host $candidateHash
