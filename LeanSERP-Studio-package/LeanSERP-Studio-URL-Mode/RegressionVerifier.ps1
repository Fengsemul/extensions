[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ReferenceBuild,

    [Parameter(Mandatory = $true)]
    [string]$CandidateBuild,

    [Parameter(Mandatory = $false)]
    [switch]$AllowKnownPrototypeDifferences
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-RequiredFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Directory,

        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    $path = Join-Path $Directory $Name

    if (
        -not (
            Test-Path `
                -LiteralPath $path `
                -PathType Leaf
        )
    ) {
        throw "Missing file: $path"
    }

    return $path
}

function Get-FileSha256 {
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

function Compare-SortedFiles {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ReferencePath,

        [Parameter(Mandatory = $true)]
        [string]$CandidatePath,

        [Parameter(Mandatory = $false)]
        [int]$SampleLimit = 100
    )

    $referenceReader =
        [System.IO.StreamReader]::new(
            $ReferencePath,
            [System.Text.UTF8Encoding]::new($false),
            $true,
            1048576
        )

    $candidateReader =
        [System.IO.StreamReader]::new(
            $CandidatePath,
            [System.Text.UTF8Encoding]::new($false),
            $true,
            1048576
        )

    $referenceOnly = [long]0
    $candidateOnly = [long]0

    $referenceSamples =
        [System.Collections.Generic.List[string]]::new()

    $candidateSamples =
        [System.Collections.Generic.List[string]]::new()

    try {
        $left = $referenceReader.ReadLine()
        $right = $candidateReader.ReadLine()

        while (
            $null -ne $left -or
            $null -ne $right
        ) {
            if ($null -eq $right) {
                $referenceOnly++

                if (
                    $referenceSamples.Count -lt
                    $SampleLimit
                ) {
                    [void]$referenceSamples.Add(
                        [string]$left
                    )
                }

                $left =
                    $referenceReader.ReadLine()

                continue
            }

            if ($null -eq $left) {
                $candidateOnly++

                if (
                    $candidateSamples.Count -lt
                    $SampleLimit
                ) {
                    [void]$candidateSamples.Add(
                        [string]$right
                    )
                }

                $right =
                    $candidateReader.ReadLine()

                continue
            }

            $comparison =
                [string]::CompareOrdinal(
                    $left,
                    $right
                )

            if ($comparison -eq 0) {
                $left =
                    $referenceReader.ReadLine()

                $right =
                    $candidateReader.ReadLine()
            }
            elseif ($comparison -lt 0) {
                $referenceOnly++

                if (
                    $referenceSamples.Count -lt
                    $SampleLimit
                ) {
                    [void]$referenceSamples.Add(
                        [string]$left
                    )
                }

                $left =
                    $referenceReader.ReadLine()
            }
            else {
                $candidateOnly++

                if (
                    $candidateSamples.Count -lt
                    $SampleLimit
                ) {
                    [void]$candidateSamples.Add(
                        [string]$right
                    )
                }

                $right =
                    $candidateReader.ReadLine()
            }
        }
    }
    finally {
        $referenceReader.Dispose()
        $candidateReader.Dispose()
    }

    return [pscustomobject]@{
        ReferenceOnly = $referenceOnly
        CandidateOnly = $candidateOnly
        ReferenceOnlySamples =
            $referenceSamples.ToArray()
        CandidateOnlySamples =
            $candidateSamples.ToArray()
    }
}

if (
    -not (
        Test-Path `
            -LiteralPath $ReferenceBuild `
            -PathType Container
    )
) {
    throw "Reference build not found: $ReferenceBuild"
}

if (
    -not (
        Test-Path `
            -LiteralPath $CandidateBuild `
            -PathType Container
    )
) {
    throw "Candidate build not found: $CandidateBuild"
}

$referenceLabels =
    Get-RequiredFile `
        -Directory $ReferenceBuild `
        -Name "labels.txt"

$candidateLabels =
    Get-RequiredFile `
        -Directory $CandidateBuild `
        -Name "labels.txt"

$referenceMetadataPath =
    Get-RequiredFile `
        -Directory $ReferenceBuild `
        -Name "metadata.json"

$candidateMetadataPath =
    Get-RequiredFile `
        -Directory $CandidateBuild `
        -Name "metadata.json"

$referenceMetadata =
    Get-Content `
        -LiteralPath $referenceMetadataPath `
        -Raw |
    ConvertFrom-Json

$candidateMetadata =
    Get-Content `
        -LiteralPath $candidateMetadataPath `
        -Raw |
    ConvertFrom-Json

$referenceLabelHash =
    Get-FileSha256 `
        -Path $referenceLabels

$candidateLabelHash =
    Get-FileSha256 `
        -Path $candidateLabels

function Get-RecordedLabelHash {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Metadata,
        [Parameter(Mandatory = $true)]
        [string]$Description
    )

    $filesProperty =
        $Metadata.PSObject.Properties[
            "files"
        ]

    if (
        $null -ne $filesProperty -and
        $null -ne $filesProperty.Value
    ) {
        $labelProperty =
            $filesProperty.Value.PSObject.Properties[
                "labels.txt"
            ]

        if (
            $null -ne $labelProperty -and
            $null -ne $labelProperty.Value
        ) {
            $hashProperty =
                $labelProperty.Value.PSObject.Properties[
                    "sha256"
                ]

            if (
                $null -ne $hashProperty -and
                -not [string]::IsNullOrWhiteSpace(
                    [string]$hashProperty.Value
                )
            ) {
                return (
                    [string]$hashProperty.Value
                ).ToLowerInvariant()
            }
        }
    }

    $compiledHashProperty =
        $Metadata.PSObject.Properties[
            "LabelsSha256"
        ]

    if (
        $null -ne $compiledHashProperty -and
        -not [string]::IsNullOrWhiteSpace(
            [string]$compiledHashProperty.Value
        )
    ) {
        return (
            [string]$compiledHashProperty.Value
        ).ToLowerInvariant()
    }

    throw (
        $Description +
        " metadata has no recorded labels SHA-256."
    )
}

$referenceRecordedHash =
    Get-RecordedLabelHash `
        -Metadata $referenceMetadata `
        -Description "Reference"

$candidateRecordedHash =
    Get-RecordedLabelHash `
        -Metadata $candidateMetadata `
        -Description "Candidate"


if (
    $referenceLabelHash -ne
    $referenceRecordedHash
) {
    throw (
        "Reference labels failed their own " +
        "SHA-256 verification."
    )
}

if (
    $candidateLabelHash -ne
    $candidateRecordedHash
) {
    throw (
        "Candidate labels failed their own " +
        "SHA-256 verification."
    )
}

$difference =
    Compare-SortedFiles `
        -ReferencePath $referenceLabels `
        -CandidatePath $candidateLabels

$knownDifferenceAccepted = $false

if ($AllowKnownPrototypeDifferences) {
    $knownDifferenceAccepted =
        $difference.ReferenceOnly -eq 1 -and
        $difference.CandidateOnly -eq 0 -and
        $difference.ReferenceOnlySamples.Count -eq 1 -and
        $difference.ReferenceOnlySamples[0] -eq
            "hluttaw"
}

$result = [pscustomobject]@{
    ReferenceBuild = $ReferenceBuild
    CandidateBuild = $CandidateBuild

    ReferenceLabelHash =
        $referenceLabelHash

    CandidateLabelHash =
        $candidateLabelHash

    HashesIdentical =
        $referenceLabelHash -eq
        $candidateLabelHash

    ReferenceOnlyLabels =
        $difference.ReferenceOnly

    CandidateOnlyLabels =
        $difference.CandidateOnly

    ReferenceOnlySamples =
        $difference.ReferenceOnlySamples

    CandidateOnlySamples =
        $difference.CandidateOnlySamples

    KnownPrototypeDifferenceAccepted =
        $knownDifferenceAccepted

    ExactMatch =
        $difference.ReferenceOnly -eq 0 -and
        $difference.CandidateOnly -eq 0
}

$result | Format-List

if (
    -not $result.ExactMatch -and
    -not $knownDifferenceAccepted
) {
    throw (
        "The candidate package differs from " +
        "the reference package."
    )
}

if ($result.ExactMatch) {
    Write-Host (
        "Regression verification passed: " +
        "label files are identical."
    ) -ForegroundColor Green
}
else {
    Write-Host (
        "Regression verification passed with " +
        "the explicitly allowed prototype difference."
    ) -ForegroundColor Yellow
}
