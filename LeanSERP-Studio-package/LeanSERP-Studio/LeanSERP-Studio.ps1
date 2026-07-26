[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string[]]$InputFile,

    [Parameter(Mandatory = $false)]
    [string]$OutputDirectory =
        "$env:USERPROFILE\Downloads\LeanSERP-Output",

    [Parameter(Mandatory = $false)]
    [ValidateRange(1000, 1000000)]
    [int]$ChunkSize = 250000,

    [Parameter(Mandatory = $false)]
    [switch]$KeepUnderscores,

    [Parameter(Mandatory = $false)]
    [switch]$KeepTemporaryFiles,

    [Parameter(Mandatory = $false)]
    [string]$ProgressLogPath = ""

)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$script:ProgressWriter = $null

if (
    -not [string]::IsNullOrWhiteSpace(
        $ProgressLogPath
    )
) {
    $progressDirectory =
        Split-Path -Parent $ProgressLogPath

    if (
        -not [string]::IsNullOrWhiteSpace(
            $progressDirectory
        )
    ) {
        New-Item `
            -ItemType Directory `
            -Path $progressDirectory `
            -Force |
            Out-Null
    }

    $script:ProgressWriter =
        [System.IO.StreamWriter]::new(
            $ProgressLogPath,
            $true,
            [System.Text.UTF8Encoding]::new(
                $false
            ),
            4096
        )

    $script:ProgressWriter.AutoFlush =
        $true
}

function Write-StudioProgress {
    param(
        [AllowEmptyString()]
        [string]$Text = ""
    )

    Write-Host $Text

    if (
        $null -ne
        $script:ProgressWriter
    ) {
        $script:ProgressWriter.WriteLine(
            $Text
        )
    }
}

$FormatName = "leanserp-label-package"
$FormatVersion = 1
$MaximumLabelLength = 63
$RejectionSampleLimit = 100

function New-Utf8NoBomWriter {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $encoding = [System.Text.UTF8Encoding]::new($false)

    return [System.IO.StreamWriter]::new(
        $Path,
        $false,
        $encoding,
        1048576
    )
}

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

function ConvertTo-LeanSerpLabel {
    param(
        [AllowEmptyString()]
        [string]$Line,

        [Parameter(Mandatory = $true)]
        [bool]$AllowUnderscore
    )

    $original = [string]$Line

    if ($null -eq $Line) {
        return [pscustomobject]@{
            Accepted = $false
            Label = ""
            Reason = "empty-line"
            Original = ""
        }
    }

        $value = $Line.TrimStart([char]0xFEFF).Trim()

    if ($value.StartsWith([string]([char]0x00EF) + [char]0x00BB + [char]0x00BF)) {
        $value = $value.Substring(3)
    }

    if ([string]::IsNullOrWhiteSpace($value)) {
        return [pscustomobject]@{
            Accepted = $false
            Label = ""
            Reason = "empty-line"
            Original = $original
        }
    }

    if (
        $value.StartsWith("#") -or
        $value.StartsWith("!")
    ) {
        return [pscustomobject]@{
            Accepted = $false
            Label = ""
            Reason = "comment-or-directive"
            Original = $original
        }
    }

    if ($value.Contains([char]0)) {
        return [pscustomobject]@{
            Accepted = $false
            Label = ""
            Reason = "nul-character"
            Original = $original
        }
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

    if ($value.StartsWith("@@")) {
        return [pscustomobject]@{
            Accepted = $false
            Label = ""
            Reason = "exception-rule"
            Original = $original
        }
    }

    $value = $value.ToLowerInvariant()

    # Remove a real BOM or common UTF-8 BOM mojibake.
    $value = $value.TrimStart([char]0xFEFF)

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

    while ($value.StartsWith($mojibakeBom)) {
        $value = $value.Substring(
            $mojibakeBom.Length
        )
    }

    while ($value.StartsWith($replacementBom)) {
        $value = $value.Substring(
            $replacementBom.Length
        )
    }

    if ($value.StartsWith("*://*.")) {
        $value = $value.Substring(6)
    }
    elseif ($value.StartsWith("*://")) {
        $value = $value.Substring(4)

        if ($value.StartsWith("*.")) {
            $value = $value.Substring(2)
        }
    }

    if ($value.EndsWith("/*")) {
        $value = $value.Substring(
            0,
            $value.Length - 2
        )
    }

    # Post-wrapper BOM cleanup v4.
    $value = $value.TrimStart([char]0xFEFF)

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

    while ($value.StartsWith($mojibakeBom)) {
        $value = $value.Substring(
            $mojibakeBom.Length
        )
    }

    while ($value.StartsWith($replacementBom)) {
        $value = $value.Substring(
            $replacementBom.Length
        )
    }

    $value = $value.Trim(".")

    if ([string]::IsNullOrEmpty($value)) {
        return [pscustomobject]@{
            Accepted = $false
            Label = ""
            Reason = "empty-after-normalization"
            Original = $original
        }
    }

    if ($value.Length -gt $MaximumLabelLength) {
        return [pscustomobject]@{
            Accepted = $false
            Label = ""
            Reason = "longer-than-63-characters"
            Original = $original
        }
    }

    if ($value.Contains(".")) {
        return [pscustomobject]@{
            Accepted = $false
            Label = ""
            Reason = "contains-dot"
            Original = $original
        }
    }

    if ($value -match '[/\\:?#*|^]') {
        return [pscustomobject]@{
            Accepted = $false
            Label = ""
            Reason = "unsupported-rule-syntax"
            Original = $original
        }
    }

    $characterPattern = if ($AllowUnderscore) {
        "^[a-z0-9_-]+$"
    }
    else {
        "^[a-z0-9-]+$"
    }

    if ($value -notmatch $characterPattern) {
        return [pscustomobject]@{
            Accepted = $false
            Label = ""
            Reason = "unsupported-characters"
            Original = $original
        }
    }

    if (
        $value.StartsWith("-") -or
        $value.EndsWith("-")
    ) {
        return [pscustomobject]@{
            Accepted = $false
            Label = ""
            Reason = "leading-or-trailing-hyphen"
            Original = $original
        }
    }

    return [pscustomobject]@{
        Accepted = $true
        Label = $value
        Reason = ""
        Original = $original
    }
}

function Write-SortedUniqueChunk {
    param(
        [Parameter(Mandatory = $true)]
        [System.Collections.Generic.HashSet[string]]$Labels,

        [Parameter(Mandatory = $true)]
        [string]$TemporaryDirectory,

        [Parameter(Mandatory = $true)]
        [int]$ChunkNumber
    )

    if ($Labels.Count -eq 0) {
        return $null
    }

    $chunkPath = Join-Path `
        $TemporaryDirectory `
        ("chunk-{0:D6}.txt" -f $ChunkNumber)

    $sorted = [string[]]$Labels
    [Array]::Sort(
        $sorted,
        [System.StringComparer]::Ordinal
    )

    $writer = New-Utf8NoBomWriter -Path $chunkPath

    try {
        foreach ($label in $sorted) {
            $writer.WriteLine($label)
        }
    }
    finally {
        $writer.Dispose()
    }

    return $chunkPath
}
function Merge-SortedChunks {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$ChunkPaths,

        [Parameter(Mandatory = $true)]
        [string]$OutputPath
    )

    if ($ChunkPaths.Count -eq 0) {
        throw "No sorted chunks were supplied."
    }

    $readers =
        [System.Collections.Generic.List[System.IO.StreamReader]]::new()

    $current =
        [System.Collections.Generic.List[object]]::new()

    $writer = New-Utf8NoBomWriter -Path $OutputPath

    $outputCount = [long]0
    $duplicateCount = [long]0
    $lastWritten = $null

    try {
        foreach ($chunkPath in $ChunkPaths) {
            $reader = [System.IO.StreamReader]::new(
                $chunkPath,
                [System.Text.UTF8Encoding]::new($false),
                $true,
                1048576
            )

            $readers.Add($reader)

            if ($reader.EndOfStream) {
                $current.Add($null)
            }
            else {
                $current.Add(
                    [string]$reader.ReadLine()
                )
            }
        }

        while ($true) {
            $lowestIndex = -1
            $lowestValue = $null

            for (
                $index = 0;
                $index -lt $current.Count;
                $index++
            ) {
                $value = $current[$index]

                if ($null -eq $value) {
                    continue
                }

                if (
                    $lowestIndex -eq -1 -or
                    [string]::CompareOrdinal(
                        [string]$value,
                        [string]$lowestValue
                    ) -lt 0
                ) {
                    $lowestIndex = $index
                    $lowestValue = [string]$value
                }
            }

            if ($lowestIndex -eq -1) {
                break
            }

            if (
                $null -eq $lastWritten -or
                -not [string]::Equals(
                    $lowestValue,
                    [string]$lastWritten,
                    [System.StringComparison]::Ordinal
                )
            ) {
                $writer.WriteLine($lowestValue)
                $lastWritten = $lowestValue
                $outputCount++
            }
            else {
                $duplicateCount++
            }

            $reader = $readers[$lowestIndex]

            if ($reader.EndOfStream) {
                $current[$lowestIndex] = $null
            }
            else {
                $current[$lowestIndex] =
                    [string]$reader.ReadLine()
            }
        }
    }
    finally {
        $writer.Dispose()

        foreach ($reader in $readers) {
            $reader.Dispose()
        }
    }

    return [pscustomobject]@{
        OutputCount = $outputCount
        DuplicateCount = $duplicateCount
    }
}
function Select-InputFiles {
    Add-Type -AssemblyName System.Windows.Forms

    $dialog =
        [System.Windows.Forms.OpenFileDialog]::new()

    $dialog.Title =
        "Select LeanSERP source text files"

    $dialog.Filter =
        "Text and list files|*.txt;*.list;*.dat|All files|*.*"

    $dialog.Multiselect = $true
    $dialog.CheckFileExists = $true

    $result = $dialog.ShowDialog()

    if (
        $result -ne
        [System.Windows.Forms.DialogResult]::OK
    ) {
        return @()
    }

    return @($dialog.FileNames)
}

if (-not $InputFile -or $InputFile.Count -eq 0) {
    $InputFile = Select-InputFiles
}

if (-not $InputFile -or $InputFile.Count -eq 0) {
    Write-Host "No input files selected."
    exit 0
}

$resolvedInputs =
    [System.Collections.Generic.List[string]]::new()

foreach ($candidate in $InputFile) {
    if (
        -not (
            Test-Path `
                -LiteralPath $candidate `
                -PathType Leaf
        )
    ) {
        throw "Input file not found: $candidate"
    }

    $resolvedInputs.Add(
        (Resolve-Path -LiteralPath $candidate).Path
    )
}

New-Item `
    -ItemType Directory `
    -Path $OutputDirectory `
    -Force |
    Out-Null

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"

$buildDirectory = Join-Path `
    $OutputDirectory `
    ("build-" + $timestamp)

$temporaryDirectory = Join-Path `
    $buildDirectory `
    "temporary-chunks"

New-Item `
    -ItemType Directory `
    -Path $temporaryDirectory `
    -Force |
    Out-Null

$outputLabelPath = Join-Path `
    $buildDirectory `
    "serp-domain-labels.txt"

$outputMetadataPath = Join-Path `
    $buildDirectory `
    "serp-domain-labels.meta.json"

$outputRejectionPath = Join-Path `
    $buildDirectory `
    "serp-domain-rejections.txt"

$rejectionWriter =
    New-Utf8NoBomWriter `
        -Path $outputRejectionPath

$chunkPaths =
    [System.Collections.Generic.List[string]]::new()

$chunkLabels =
    [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::Ordinal
    )

$reasonCounts = @{}
$rejectionSamples =
    [System.Collections.Generic.List[string]]::new()

$sourceReports =
    [System.Collections.Generic.List[object]]::new()

$totalLines = [long]0
$totalAcceptedLines = [long]0
$totalRejectedLines = [long]0
$chunkNumber = 0
$duplicatesRemovedInChunks = [long]0
$buildStarted = [DateTimeOffset]::UtcNow

try {
    foreach ($inputPath in $resolvedInputs) {
        Write-StudioProgress `
    -Text "Reading: $inputPath"


        $sourceLines = [long]0
        $sourceAccepted = [long]0
        $sourceRejected = [long]0
        $sourceBytes =
            (Get-Item -LiteralPath $inputPath).Length

        $reader = [System.IO.StreamReader]::new(
            $inputPath,
            [System.Text.UTF8Encoding]::new($false),
            $true,
            1048576
        )

        try {
            while (
                -not $reader.EndOfStream
            ) {
                $line = $reader.ReadLine()

                $sourceLines++
                $totalLines++

                $parsed = ConvertTo-LeanSerpLabel `
                    -Line $line `
                    -AllowUnderscore ([bool]$KeepUnderscores)

                if ($parsed.Accepted) {
                    $sourceAccepted++
                    $totalAcceptedLines++

$added = $chunkLabels.Add(
    $parsed.Label
)

if (-not $added) {
    $duplicatesRemovedInChunks++
}


                    if (
                        $chunkLabels.Count -ge
                        $ChunkSize
                    ) {
                        $chunkNumber++

                        $chunkPath =
                            Write-SortedUniqueChunk `
                                -Labels $chunkLabels `
                                -TemporaryDirectory $temporaryDirectory `
                                -ChunkNumber $chunkNumber

                        if ($chunkPath) {
                            $chunkPaths.Add(
                                $chunkPath
                            )
                        }

                        $chunkLabels.Clear()

                      Write-StudioProgress `
    -Text (
        "Created chunk {0}; processed {1:N0} lines." -f
        $chunkNumber,
        $totalLines
    )

                    }
                }
                else {
                    $sourceRejected++
                    $totalRejectedLines++

                    if (
                        -not $reasonCounts.ContainsKey(
                            $parsed.Reason
                        )
                    ) {
                        $reasonCounts[
                            $parsed.Reason
                        ] = [long]0
                    }

                    $reasonCounts[
                        $parsed.Reason
                    ]++
                    $rejectionRecord = [string]::Join(
                        "`t",
                        @(
                            [string]$parsed.Reason,
                            [string]$inputPath,
                            [string]$parsed.Original
                        )
                    )
                    $rejectionWriter.WriteLine(
                        $rejectionRecord
                    )

                    if (
                        $rejectionSamples.Count -lt
                        $RejectionSampleLimit
                    ) {
                        $rejectionSamples.Add(
                            (
                                "{0}: {1}" -f
                                $parsed.Reason,
                                $parsed.Original
                            )
                        )
                    }
                }
            }
        }
        finally {
            $reader.Dispose()
        }

        $sourceReports.Add(
            [pscustomobject]@{
                path = $inputPath
                byteLength = $sourceBytes
                sha256 = Get-Sha256 -Path $inputPath
                lines = $sourceLines
                acceptedLines = $sourceAccepted
                rejectedLines = $sourceRejected
            }
        )
    }

    if ($chunkLabels.Count -gt 0) {
        $chunkNumber++

        $chunkPath =
            Write-SortedUniqueChunk `
                -Labels $chunkLabels `
                -TemporaryDirectory $temporaryDirectory `
                -ChunkNumber $chunkNumber

        if ($chunkPath) {
            $chunkPaths.Add($chunkPath)
        }

        $chunkLabels.Clear()
    }
}
finally {
    $rejectionWriter.Dispose()
}

if ($chunkPaths.Count -eq 0) {
    throw "No valid labels were found."
}

Write-StudioProgress `
    -Text (
        "Merging {0:N0} sorted chunks..." -f
        $chunkPaths.Count
    )


$mergeResult = Merge-SortedChunks `
    -ChunkPaths $chunkPaths.ToArray() `
    -OutputPath $outputLabelPath

$outputHash = Get-Sha256 `
    -Path $outputLabelPath

$buildFinished = [DateTimeOffset]::UtcNow

$metadata = [ordered]@{
    format = $FormatName
    version = $FormatVersion
    encoding = "utf-8"
    sorted = $true
    deduplicated = $true
    underscoresAllowed = [bool]$KeepUnderscores
    labelCount = $mergeResult.OutputCount
    inputLineCount = $totalLines
    acceptedInputLines = $totalAcceptedLines
    rejectedInputLines = $totalRejectedLines
duplicateLabelsRemoved =
    $duplicatesRemovedInChunks +
    $mergeResult.DuplicateCount
    sha256 = $outputHash
    createdAt = $buildFinished.ToString("o")
    durationSeconds = [math]::Round(
        (
            $buildFinished -
            $buildStarted
        ).TotalSeconds,
        3
    )
    sourceCount = $sourceReports.Count
    sources = $sourceReports
    rejectionReasons = $reasonCounts
    rejectionSamples = $rejectionSamples
}

$metadataJson =
    $metadata |
    ConvertTo-Json -Depth 10

[System.IO.File]::WriteAllText(
    $outputMetadataPath,
    $metadataJson + [Environment]::NewLine,
    [System.Text.UTF8Encoding]::new($false)
)

if (-not $KeepTemporaryFiles) {
    Remove-Item `
        -LiteralPath $temporaryDirectory `
        -Recurse `
        -Force
}

Write-StudioProgress

Write-StudioProgress `
    -Text "LeanSERP Studio build completed."

Write-StudioProgress `
    -Text (
        "Unique labels: {0:N0}" -f
        $mergeResult.OutputCount
    )

Write-StudioProgress `
    -Text (
        "Rejected lines: {0:N0}" -f
        $totalRejectedLines
    )

Write-StudioProgress `
    -Text (
        "Duplicate labels removed: {0:N0}" -f
        (
            $duplicatesRemovedInChunks +
            $mergeResult.DuplicateCount
        )
    )

Write-StudioProgress `
    -Text "Label package:"

Write-StudioProgress `
    -Text $outputLabelPath

Write-StudioProgress `
    -Text "Metadata:"

Write-StudioProgress `
    -Text $outputMetadataPath

Write-StudioProgress `
    -Text "Rejection report:"

Write-StudioProgress `
    -Text $outputRejectionPath

Write-StudioProgress `
    -Text "SHA-256:"

Write-StudioProgress `
    -Text $outputHash

if ($null -ne $script:ProgressWriter) {
    try {
        $script:ProgressWriter.Flush()
        $script:ProgressWriter.Dispose()
    }
    catch {
    }

    $script:ProgressWriter = $null
}
