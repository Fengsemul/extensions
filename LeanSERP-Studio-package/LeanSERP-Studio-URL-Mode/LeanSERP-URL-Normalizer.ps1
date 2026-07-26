[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string[]]$InputFile,

    [Parameter(Mandatory = $false)]
    [string]$PublicSuffixList = "",

    [Parameter(Mandatory = $false)]
    [string]$ApprovedRulesDirectory = "",

    [Parameter(Mandatory = $false)]
    [string]$OutputDirectory =
        "$env:USERPROFILE\Downloads\LeanSERP-URL-Output",

    [Parameter(Mandatory = $false)]
    [ValidateRange(1000, 1000000)]
    [int]$ChunkSize = 250000,

    [Parameter(Mandatory = $false)]
    [switch]$KeepUnderscores,

    [Parameter(Mandatory = $false)]
    [switch]$RemoveCommonWwwLabels,

    [Parameter(Mandatory = $false)]
    [switch]$KeepTemporaryFiles,

    [Parameter(Mandatory = $false)]
    [ValidateSet(
        "None",
        "Normal",
        "Extended",
        "Regex"
    )]
    [string]$ReplacementMode = "None",

    [Parameter(Mandatory = $false)]
    [string]$FindText = "",

    [Parameter(Mandatory = $false)]
    [string]$ReplaceText = "",

    [Parameter(Mandatory = $false)]
    [switch]$CaseSensitive,

    [Parameter(Mandatory = $false)]
    [switch]$PreviewOnly,

    [Parameter(Mandatory = $false)]
    [ValidateRange(1, 1000)]
    [int]$PreviewLimit = 100,

    [Parameter(Mandatory = $false)]
    [string]$ProgressLogPath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptDirectory =
    Split-Path -Parent $MyInvocation.MyCommand.Path

if (
    [string]::IsNullOrWhiteSpace(
        $PublicSuffixList
    )
) {
    $PublicSuffixList =
        Join-Path `
            $scriptDirectory `
            "public_suffix_list.dat"
}

if (
    [string]::IsNullOrWhiteSpace(
        $ApprovedRulesDirectory
    )
) {
    $ApprovedRulesDirectory =
        Join-Path `
            $scriptDirectory `
            "Approved-Rules"
}

$MaximumHostnameLength = 253
$MaximumLabelLength = 63
$MaximumRejectedSamples = 100
$FormatName = "leanserp-url-package"
$FormatVersion = 1
$script:ProgressWriter = $null

function New-Utf8Writer {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $false)]
        [bool]$Append = $false
    )

    return [System.IO.StreamWriter]::new(
        $Path,
        $Append,
        [System.Text.UTF8Encoding]::new(
            $false
        ),
        1048576
    )
}

function Open-ProgressWriter {
    if (
        [string]::IsNullOrWhiteSpace(
            $ProgressLogPath
        )
    ) {
        return
    }

    $progressDirectory =
        Split-Path -Parent $ProgressLogPath

    if (
        -not [string]::IsNullOrWhiteSpace(
            $progressDirectory
        )
    ) {
        [void](
            New-Item `
                -ItemType Directory `
                -Path $progressDirectory `
                -Force
        )
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

function Close-ProgressWriter {
    if (
        $null -eq
        $script:ProgressWriter
    ) {
        return
    }

    try {
        $script:ProgressWriter.Flush()
        $script:ProgressWriter.Dispose()
    }
    catch {
    }

    $script:ProgressWriter = $null
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

function Remove-BomArtifacts {
    param(
        [AllowEmptyString()]
        [string]$Value
    )

    $text = [string]$Value
    $text =
        $text.TrimStart([char]0xFEFF)

    $mojibakeBom =
        [string]::Concat(
            [char]0x00EF,
            [char]0x00BB,
            [char]0x00BF
        )

    $replacementBom =
        [string]::Concat(
            [char]0x00EF,
            [char]0x00BF,
            [char]0x00BD
        )

    while (
        $text.StartsWith(
            $mojibakeBom
        )
    ) {
        $text =
            $text.Substring(
                $mojibakeBom.Length
            )
    }

    while (
        $text.StartsWith(
            $replacementBom
        )
    ) {
        $text =
            $text.Substring(
                $replacementBom.Length
            )
    }

    return $text
}

function ConvertFrom-ExtendedText {
    param(
        [AllowEmptyString()]
        [string]$Value
    )

    $builder =
        [System.Text.StringBuilder]::new()

    for (
        $index = 0;
        $index -lt $Value.Length;
        $index++
    ) {
        $character = $Value[$index]

        if (
            $character -ne "\" -or
            $index + 1 -ge $Value.Length
        ) {
            [void]$builder.Append(
                $character
            )
            continue
        }

        $index++
        $next = $Value[$index]

        switch ($next) {
            "n" {
                [void]$builder.Append("`n")
            }

            "r" {
                [void]$builder.Append("`r")
            }

            "t" {
                [void]$builder.Append("`t")
            }

            "\" {
                [void]$builder.Append("\")
            }

            default {
                [void]$builder.Append("\")
                [void]$builder.Append(
                    $next
                )
            }
        }
    }

    return $builder.ToString()
}

function Invoke-LineReplacement {
    param(
        [AllowEmptyString()]
        [string]$Line
    )

    if (
        $ReplacementMode -eq "None" -or
        [string]::IsNullOrEmpty(
            $FindText
        )
    ) {
        return [pscustomobject]@{
            Text = $Line
            Changed = $false
        }
    }

    $findValue = $FindText
    $replaceValue = $ReplaceText

    if (
        $ReplacementMode -eq
        "Extended"
    ) {
        $findValue =
            ConvertFrom-ExtendedText `
                -Value $FindText

        $replaceValue =
            ConvertFrom-ExtendedText `
                -Value $ReplaceText
    }

    if (
        $ReplacementMode -eq "Regex"
    ) {
        $options =
            [System.Text.RegularExpressions.RegexOptions]::CultureInvariant

        if (-not $CaseSensitive) {
            $options =
                $options -bor
                [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
        }

        $regex =
            [System.Text.RegularExpressions.Regex]::new(
                $findValue,
                $options
            )

        return [pscustomobject]@{
            Text = $regex.Replace(
                $Line,
                $replaceValue
            )
            Changed = $regex.IsMatch(
                $Line
            )
        }
    }

    if ($CaseSensitive) {
        return [pscustomobject]@{
            Text = $Line.Replace(
                $findValue,
                $replaceValue
            )
            Changed = $Line.Contains(
                $findValue
            )
        }
    }

    $pattern =
        [regex]::Escape(
            $findValue
        )

    return [pscustomobject]@{
        Text = [regex]::Replace(
            $Line,
            $pattern,
            [System.Text.RegularExpressions.MatchEvaluator]{
                param($match)
                return $replaceValue
            },
            [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
        )
        Changed = [regex]::IsMatch(
            $Line,
            $pattern,
            [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
        )
    }
}

function Import-PublicSuffixRules {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $exact =
        [System.Collections.Generic.HashSet[string]]::new(
            [System.StringComparer]::OrdinalIgnoreCase
        )

    $wildcards =
        [System.Collections.Generic.HashSet[string]]::new(
            [System.StringComparer]::OrdinalIgnoreCase
        )

    $exceptions =
        [System.Collections.Generic.HashSet[string]]::new(
            [System.StringComparer]::OrdinalIgnoreCase
        )

    $reader =
        [System.IO.StreamReader]::new(
            $Path,
            [System.Text.UTF8Encoding]::new(
                $false
            ),
            $true,
            1048576
        )

    try {
        while (
            -not $reader.EndOfStream
        ) {
            $line = $reader.ReadLine()

            if ($null -eq $line) {
                continue
            }

            $line = $line.Trim()

            if (
                -not $line -or
                $line.StartsWith("//")
            ) {
                continue
            }

            $commentIndex =
                $line.IndexOf(" //")

            if ($commentIndex -ge 0) {
                $line =
                    $line.Substring(
                        0,
                        $commentIndex
                    ).Trim()
            }

            if (-not $line) {
                continue
            }

            $line =
                $line.ToLowerInvariant()

            if ($line.StartsWith("!")) {
                [void]$exceptions.Add(
                    $line.Substring(1)
                )
            }
            elseif (
                $line.StartsWith("*.")
            ) {
                [void]$wildcards.Add(
                    $line.Substring(2)
                )
            }
            else {
                [void]$exact.Add(
                    $line
                )
            }
        }
    }
    finally {
        $reader.Dispose()
    }

    if (
        $exact.Count -lt 1000 -or
        -not $exact.Contains("com") -or
        -not $exact.Contains("co.uk") -or
        -not $wildcards.Contains("ck") -or
        -not $exceptions.Contains("www.ck")
    ) {
        throw (
            "The Public Suffix List " +
            "failed validation."
        )
    }

    return [pscustomobject]@{
        Exact = $exact
        Wildcards = $wildcards
        Exceptions = $exceptions
        RuleCount =
            $exact.Count +
            $wildcards.Count +
            $exceptions.Count
    }
}

function Get-PublicSuffixLength {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Hostname,
        [Parameter(Mandatory = $true)]
        [object]$Rules
    )

    $labels = [string[]](
        $Hostname -split "\."
    )

    $labelCount = $labels.Length

    if ($labelCount -lt 2) {
        return 1
    }

    $bestLength = 1
    $candidate = ""

    for (
        $index = $labelCount - 1;
        $index -ge 0;
        $index--
    ) {
        if ($candidate.Length -eq 0) {
            $candidate = $labels[$index]
        }
        else {
            $candidate =
                $labels[$index] +
                "." +
                $candidate
        }

        $candidateLength =
            $labelCount - $index

        if (
            $Rules.Exceptions.Contains(
                $candidate
            )
        ) {
            return [Math]::Max(
                1,
                $candidateLength - 1
            )
        }

        if (
            $Rules.Exact.Contains(
                $candidate
            ) -and
            $candidateLength -gt
                $bestLength
        ) {
            $bestLength =
                $candidateLength
        }

        if ($index -lt $labelCount - 1) {
            $wildcardBase =
                $candidate.Substring(
                    $labels[$index].Length +
                    1
                )

            if (
                $Rules.Wildcards.Contains(
                    $wildcardBase
                ) -and
                $candidateLength -gt
                    $bestLength
            ) {
                $bestLength =
                    $candidateLength
            }
        }
    }

    return [Math]::Min(
        $bestLength,
        $labelCount
    )
}

function Import-NormalizedLines {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [ValidateSet(
            "label",
            "hostname"
        )]
        [string]$Kind
    )

    $values =
        [System.Collections.Generic.HashSet[string]]::new(
            [System.StringComparer]::OrdinalIgnoreCase
        )

    if (
        -not (
            Test-Path `
                -LiteralPath $Path `
                -PathType Leaf
        )
    ) {
        return $values
    }

    $reader =
        [System.IO.StreamReader]::new(
            $Path,
            [System.Text.UTF8Encoding]::new(
                $false
            ),
            $true,
            65536
        )

    try {
        while (
            -not $reader.EndOfStream
        ) {
            $line = $reader.ReadLine()

            if ($null -eq $line) {
                continue
            }

            $line =
                Remove-BomArtifacts `
                    -Value $line

            $line =
                $line.Trim().ToLowerInvariant()

            if (
                -not $line -or
                $line.StartsWith("#")
            ) {
                continue
            }

            if (
                $Kind -eq "label" -and
                $line -match
                    "^[a-z0-9_-]{1,63}$"
            ) {
                [void]$values.Add(
                    $line
                )
            }
            elseif (
                $Kind -eq "hostname" -and
                $line.Contains(".") -and
                $line -match
                    "^[a-z0-9._-]+$"
            ) {
                [void]$values.Add(
                    $line.Trim(".")
                )
            }
        }
    }
    finally {
        $reader.Dispose()
    }

    return $values
}

function New-ParseResult {
    param(
        [AllowEmptyString()]
        [string]$Hostname = "",

        [AllowEmptyString()]
        [string]$CompactLabel = "",

        [AllowEmptyString()]
        [string]$Reason = ""
    )

    return [pscustomobject]@{
        Hostname = $Hostname
        CompactLabel = $CompactLabel
        Reason = $Reason
    }
}

function ConvertTo-AsciiHostname {
    param(
        [AllowEmptyString()]
        [string]$Value
    )

    $text =
        Remove-BomArtifacts `
            -Value $Value

    $text = $text.Trim()

    if (
        [string]::IsNullOrWhiteSpace(
            $text
        ) -or
        $text.StartsWith("#") -or
        $text.StartsWith("!") -or
        $text.Contains([char]0)
    ) {
        return New-ParseResult `
            -Reason "empty-comment-or-directive"
    }

    $fields = $text -split "\s+"

    if (
        $fields.Count -ge 2 -and
        $fields[0] -match
            "^(?:0\.0\.0\.0|127\.0\.0\.1|::1)$"
    ) {
        $text = $fields[1]
    }
    else {
        $text = $fields[0]
    }

    if ($text.StartsWith("@@")) {
        return New-ParseResult `
            -Reason "exception-rule"
    }

    $text = $text.ToLowerInvariant()

    $markdownMatch =
        [regex]::Match(
            $text,
            '^\[[^\]]*\]\((https?://[^)]+)\)$',
            [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
        )

    if ($markdownMatch.Success) {
        $text =
            $markdownMatch.Groups[1].Value
    }

    if ($text.StartsWith("*://*.")) {
        $text = $text.Substring(6)
    }
    elseif (
        $text.StartsWith("*://")
    ) {
        $text = $text.Substring(4)

        if ($text.StartsWith("*.")) {
            $text = $text.Substring(2)
        }
    }
    elseif (
        $text -match
        "^[a-z][a-z0-9+.-]*://"
    ) {
        try {
            $uri =
                [System.Uri]$text

            $text =
                $uri.DnsSafeHost
        }
        catch {
            return New-ParseResult `
                -Reason "invalid-url"
        }
    }

    $text =
        Remove-BomArtifacts `
            -Value $text

    $text =
        $text -replace
        "[/?#].*$",
        ""

    if ($text.Contains("@")) {
        $text =
            ($text -split "@")[-1]
    }

    $text =
        $text -replace
        ":\d+$",
        ""

    $text = $text.Trim(".")

    if (
        $text -match
        "^[a-z0-9_-]{1,63}$"
    ) {
        return New-ParseResult `
            -CompactLabel $text
    }

    if (
        [string]::IsNullOrWhiteSpace(
            $text
        ) -or
        $text.Length -gt
            $MaximumHostnameLength -or
        $text.Contains(":") -or
        -not $text.Contains(".")
    ) {
        return New-ParseResult `
            -Reason "invalid-hostname"
    }

    try {
        $idn =
            [System.Globalization.IdnMapping]::new()

        $asciiLabels =
            [System.Collections.Generic.List[string]]::new()

        $characterPattern =
            if ($KeepUnderscores) {
                "^[a-z0-9_-]+$"
            }
            else {
                "^[a-z0-9-]+$"
            }

        foreach (
            $label in
                ($text -split "\.")
        ) {
            if (
                [string]::IsNullOrWhiteSpace(
                    $label
                )
            ) {
                return New-ParseResult `
                    -Reason "empty-hostname-label"
            }

            $asciiLabel =
                $idn.GetAscii(
                    $label
                ).ToLowerInvariant()

            if (
                $asciiLabel.Length -lt 1 -or
                $asciiLabel.Length -gt
                    $MaximumLabelLength -or
                $asciiLabel -notmatch
                    $characterPattern -or
                $asciiLabel.StartsWith("-") -or
                $asciiLabel.EndsWith("-")
            ) {
                return New-ParseResult `
                    -Reason "invalid-hostname-label"
            }

            [void]$asciiLabels.Add(
                $asciiLabel
            )
        }

        $text =
            $asciiLabels -join "."
    }
    catch {
        return New-ParseResult `
            -Reason "idn-conversion-failed"
    }

    return New-ParseResult `
        -Hostname $text
}

function Remove-ConfiguredWwwLabels {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Hostname
    )

    if (-not $RemoveCommonWwwLabels) {
        return $Hostname
    }

    $labels =
        [System.Collections.Generic.List[string]]::new()

    foreach (
        $label in
            ($Hostname -split "\.")
    ) {
        [void]$labels.Add(
            $label
        )
    }

    while (
        $labels.Count -gt 2 -and
        $labels[0] -match
            "^www\d*$"
    ) {
        $labels.RemoveAt(0)
    }

    return $labels -join "."
}

function Analyze-Hostname {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Hostname,

        [Parameter(Mandatory = $true)]
        [object]$Rules,

        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [System.Collections.Generic.HashSet[string]]$PslOverrides
    )

    $labels = @(
        $Hostname -split "\."
    )

    $suffixLength =
        Get-PublicSuffixLength `
            -Hostname $Hostname `
            -Rules $Rules

    $suffixStart =
        $labels.Count -
        $suffixLength

    $publicSuffix =
        $labels[
            $suffixStart..
            ($labels.Count - 1)
        ] -join "."

    $overrideLabels =
        [System.Collections.Generic.List[string]]::new()

    foreach (
        $suffixLabel in
            $labels[
                $suffixStart..
                ($labels.Count - 1)
            ]
    ) {
        if (
            $PslOverrides.Contains(
                $suffixLabel
            )
        ) {
            [void]$overrideLabels.Add(
                $suffixLabel
            )
        }
    }

    if ($suffixStart -le 0) {
        return [pscustomobject]@{
            Hostname = $Hostname
            PublicSuffix = $publicSuffix
            RegistrableDomain = ""
            MainLabel = ""
            SubdomainLabels = @()
            OverrideLabels =
                $overrideLabels.ToArray()
            Classification =
                "public-suffix-only"
        }
    }

    $mainLabelIndex =
        $suffixStart - 1

    $mainLabel =
        $labels[$mainLabelIndex]

    $registrableDomain =
        $labels[
            $mainLabelIndex..
            ($labels.Count - 1)
        ] -join "."

    $subdomains = @()

    if ($mainLabelIndex -gt 0) {
        $subdomains = @(
            $labels[
                0..
                ($mainLabelIndex - 1)
            ]
        )
    }

    return [pscustomobject]@{
        Hostname = $Hostname
        PublicSuffix = $publicSuffix
        RegistrableDomain =
            $registrableDomain
        MainLabel = $mainLabel
        SubdomainLabels = $subdomains
        OverrideLabels =
            $overrideLabels.ToArray()
        Classification =
            "registrable-domain"
    }
}

function Write-SortedChunk {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [System.Collections.Generic.HashSet[string]]$Values,

        [Parameter(Mandatory = $true)]
        [string]$Directory,

        [Parameter(Mandatory = $true)]
        [string]$Prefix,

        [Parameter(Mandatory = $true)]
        [int]$Number
    )

    if ($Values.Count -eq 0) {
        return $null
    }

    $path =
        Join-Path `
            $Directory `
            (
                $Prefix +
                "-" +
                ("{0:D6}" -f $Number) +
                ".txt"
            )

    $sorted =
        [string[]]$Values

    [Array]::Sort(
        $sorted,
        [System.StringComparer]::Ordinal
    )

    $writer =
        New-Utf8Writer `
            -Path $path

    try {
        foreach ($value in $sorted) {
            $writer.WriteLine(
                $value
            )
        }
    }
    finally {
        $writer.Dispose()
    }

    return $path
}

function Merge-SortedChunks {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [AllowNull()]
        [string[]]$ChunkPaths,

        [Parameter(Mandatory = $true)]
        [string]$OutputPath
    )

    $writer =
        New-Utf8Writer `
            -Path $OutputPath

    $paths = @(
        $ChunkPaths |
            Where-Object {
                -not [string]::IsNullOrWhiteSpace(
                    [string]$_
                )
            }
    )

    if (@($paths).Count -eq 0) {
        $writer.Dispose()

        return [pscustomobject]@{
            OutputCount = [long]0
            DuplicatesRemoved = [long]0
        }
    }

    $readers =
        [System.Collections.Generic.List[System.IO.StreamReader]]::new()

    $current =
        [System.Collections.Generic.List[object]]::new()

    $outputCount = [long]0
    $duplicates = [long]0
    $lastWritten = $null

    try {
        foreach ($chunkPath in $paths) {
            if (
                -not (
                    Test-Path `
                        -LiteralPath $chunkPath `
                        -PathType Leaf
                )
            ) {
                throw
                "Sorted chunk was not found: $chunkPath"
            }
            $reader =
                [System.IO.StreamReader]::new(
                    $chunkPath,
                    [System.Text.UTF8Encoding]::new(
                        $false
                    ),
                    $true,
                    1048576
                )
            [void]$readers.Add(
                $reader
            )
            if ($reader.EndOfStream) {
                [void]$current.Add(
                    $null
                )
            }
            else {
                [void]$current.Add(
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
                $value =
                    $current[$index]
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
                    $lowestIndex =
                        $index
                    $lowestValue =
                        [string]$value
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
                $writer.WriteLine(
                    $lowestValue
                )
                $lastWritten =
                    $lowestValue
                $outputCount++
            }
            else {
                $duplicates++
            }
            $reader =
                $readers[$lowestIndex]
            if ($reader.EndOfStream) {
                $current[$lowestIndex] =
                    $null
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
        OutputCount =
            $outputCount
        DuplicatesRemoved =
            $duplicates
    }
}

function Add-ToChunk {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Value,
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [System.Collections.Generic.HashSet[string]]$Set,
        [Parameter(Mandatory = $true)]
        [ref]$DuplicateCounter
    )
    if (-not $Set.Add($Value)) {
        $DuplicateCounter.Value =
            [long]$DuplicateCounter.Value +
            1
    }
}

function Flush-ChunkSet {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [System.Collections.Generic.HashSet[string]]$Set,
        [Parameter(Mandatory = $true)]
        [string]$TemporaryDirectory,
        [Parameter(Mandatory = $true)]
        [string]$Prefix,
        [Parameter(Mandatory = $true)]
        [ref]$ChunkNumber,
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [System.Collections.Generic.List[string]]$Paths
    )
    if ($Set.Count -eq 0) {
        return
    }
    $ChunkNumber.Value =
        [int]$ChunkNumber.Value +
        1
    $path =
        Write-SortedChunk `
            -Values $Set `
            -Directory $TemporaryDirectory `
            -Prefix $Prefix `
            -Number $ChunkNumber.Value
    if ($path) {
        [void]$Paths.Add(
            $path
        )
    }
    $Set.Clear()
}

if (
    -not $InputFile -or
    $InputFile.Count -eq 0
) {
    throw "No input files were supplied."
}

if (
    -not (
        Test-Path `
            -LiteralPath $PublicSuffixList `
            -PathType Leaf
    )
) {
    throw (
        "Public Suffix List not found: " +
        $PublicSuffixList
    )
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
        throw (
            "Input file not found: " +
            $candidate
        )
    }
    $resolved =
        (
            Resolve-Path `
                -LiteralPath $candidate
        ).Path
    if (
        -not $resolvedInputs.Contains(
            $resolved
        )
    ) {
        [void]$resolvedInputs.Add(
            $resolved
        )
    }
}

[void](
    New-Item `
        -ItemType Directory `
        -Path $OutputDirectory `
        -Force
)

$timestamp =
    Get-Date -Format "yyyyMMdd-HHmmss"

$buildDirectory =
    Join-Path `
        $OutputDirectory `
        (
            "url-build-" +
            $timestamp
        )

$temporaryDirectory =
    Join-Path `
        $buildDirectory `
        "temporary-chunks"

[void](
    New-Item `
        -ItemType Directory `
        -Path $temporaryDirectory `
        -Force
)

$labelsOutputPath =
    Join-Path `
        $buildDirectory `
        "labels.txt"

$exactHostsOutputPath =
    Join-Path `
        $buildDirectory `
        "exact-host-blocks.txt"

$hostSubdomainsOutputPath =
    Join-Path `
        $buildDirectory `
        "host-subdomain-blocks.txt"

$pslOverridesOutputPath =
    Join-Path `
        $buildDirectory `
        "psl-label-overrides.txt"

$rejectedOutputPath =
    Join-Path `
        $buildDirectory `
        "rejected-lines.tsv"

$previewOutputPath =
    Join-Path `
        $buildDirectory `
        "transformation-preview.tsv"

$metadataOutputPath =
    Join-Path `
        $buildDirectory `
        "metadata.json"

$exactHostRulesPath =
    Join-Path `
        $ApprovedRulesDirectory `
        "exact-host-blocks-approved.txt"

$pslOverrideRulesPath =
    Join-Path `
        $ApprovedRulesDirectory `
        "psl-label-overrides-approved.txt"

Open-ProgressWriter

try {
    Write-StudioProgress `
        -Text "Loading the Public Suffix List..."

    $publicSuffixRules =
        Import-PublicSuffixRules `
            -Path $PublicSuffixList

    $approvedExactHosts =
        Import-NormalizedLines `
            -Path $exactHostRulesPath `
            -Kind "hostname"

    $approvedPslOverrides =
        Import-NormalizedLines `
            -Path $pslOverrideRulesPath `
            -Kind "label"

    Write-StudioProgress `
        -Text (
            "Loaded {0:N0} Public Suffix List rules." -f
            $publicSuffixRules.RuleCount
        )

    Write-StudioProgress `
        -Text (
            "Loaded {0:N0} approved exact-host blocks." -f
            $approvedExactHosts.Count
        )

    Write-StudioProgress `
        -Text (
            "Loaded {0:N0} approved PSL label overrides." -f
            $approvedPslOverrides.Count
        )

    $labelSet =
        [System.Collections.Generic.HashSet[string]]::new(
            [System.StringComparer]::Ordinal
        )

    $exactHostSet =
        [System.Collections.Generic.HashSet[string]]::new(
            [System.StringComparer]::Ordinal
        )

    $hostSubdomainSet =
        [System.Collections.Generic.HashSet[string]]::new(
            [System.StringComparer]::Ordinal
        )

    $overrideSet =
        [System.Collections.Generic.HashSet[string]]::new(
            [System.StringComparer]::Ordinal
        )

    $labelChunkPaths =
        [System.Collections.Generic.List[string]]::new()

    $exactHostChunkPaths =
        [System.Collections.Generic.List[string]]::new()

    $hostSubdomainChunkPaths =
        [System.Collections.Generic.List[string]]::new()

    $overrideChunkPaths =
        [System.Collections.Generic.List[string]]::new()

    $labelChunkNumber = 0
    $exactHostChunkNumber = 0
    $hostSubdomainChunkNumber = 0
    $overrideChunkNumber = 0

    $labelDuplicatesInChunks = [long]0
    $exactHostDuplicatesInChunks = [long]0
    $hostSubdomainDuplicatesInChunks = [long]0
    $overrideDuplicatesInChunks = [long]0

    $totalLines = [long]0
    $acceptedLines = [long]0
    $rejectedLines = [long]0
    $changedLines = [long]0
    $compactLabelLines = [long]0
    $hostnameLines = [long]0
    $publicSuffixOnlyLines = [long]0
    $exactHostMatches = [long]0

    $rejectionReasons = @{}

    $rejectionSamples =
        [System.Collections.Generic.List[string]]::new()

    $transformationPreview =
        [System.Collections.Generic.List[object]]::new()

    $sourceReports =
        [System.Collections.Generic.List[object]]::new()

    $rejectedWriter =
        New-Utf8Writer `
            -Path $rejectedOutputPath

    $previewWriter =
        New-Utf8Writer `
            -Path $previewOutputPath

    $startedAt =
        [DateTimeOffset]::UtcNow

    try {
        $rejectedWriter.WriteLine(
            [string]::Join(
                "`t",
                @(
                    "reason",
                    "source",
                    "line",
                    "original"
                )
            )
        )

        $previewWriter.WriteLine(
            [string]::Join(
                "`t",
                @(
                    "source",
                    "line",
                    "original",
                    "transformed"
                )
            )
        )

        foreach (
            $inputPath in
            $resolvedInputs
        ) {
            Write-StudioProgress `
                -Text (
                    "Reading: " +
                    $inputPath
                )

            $sourceBytes =
                (
                    Get-Item `
                        -LiteralPath $inputPath
                ).Length

            $sourceSha256 =
                Get-Sha256 `
                    -Path $inputPath

            $sourceLines = [long]0
            $sourceAccepted = [long]0
            $sourceRejected = [long]0
            $sourceChanged = [long]0

            $reader =
                [System.IO.StreamReader]::new(
                    $inputPath,
                    [System.Text.UTF8Encoding]::new(
                        $false
                    ),
                    $true,
                    1048576
                )

            try {
                while (
                    -not $reader.EndOfStream
                ) {
                    $originalLine =
                        $reader.ReadLine()

                    $sourceLines++
                    $totalLines++

                    $replacement =
                        Invoke-LineReplacement `
                            -Line $originalLine

                    $workingLine =
                        [string]$replacement.Text

                    if ($replacement.Changed) {
                        $sourceChanged++
                        $changedLines++

                        if (
                            $transformationPreview.Count -lt
                            $PreviewLimit
                        ) {
                            [void]$transformationPreview.Add(
                                [pscustomobject]@{
                                    Source = $inputPath
                                    Line = $sourceLines
                                    Original = $originalLine
                                    Transformed = $workingLine
                                }
                            )

                            $previewWriter.WriteLine(
                                [string]::Join(
                                    "`t",
                                    @(
                                        $inputPath,
                                        [string]$sourceLines,
                                        (
                                            [string]$originalLine
                                        ).Replace(
                                            "`t",
                                            " "
                                        ),
                                        (
                                            [string]$workingLine
                                        ).Replace(
                                            "`t",
                                            " "
                                        )
                                    )
                                )
                            )
                        }
                    }

                    $parsed =
                        ConvertTo-AsciiHostname `
                            -Value $workingLine

                    if ($parsed.CompactLabel) {
                        $compactLabelLines++
                        $acceptedLines++
                        $sourceAccepted++

                        Add-ToChunk `
                            -Value $parsed.CompactLabel `
                            -Set $labelSet `
                            -DuplicateCounter (
                                [ref]$labelDuplicatesInChunks
                            )
                    }
                    elseif ($parsed.Hostname) {
                        $hostnameLines++

                        $hostname =
                            Remove-ConfiguredWwwLabels `
                                -Hostname $parsed.Hostname

                        $analysis =
                            Analyze-Hostname `
                                -Hostname $hostname `
                                -Rules $publicSuffixRules `
                                -PslOverrides $approvedPslOverrides

                        if (
                            $analysis.Classification -eq
                            "public-suffix-only"
                        ) {
                            $publicSuffixOnlyLines++

                            foreach (
                                $overrideLabel in
                                @($analysis.OverrideLabels)
                            ) {
                                Add-ToChunk `
                                    -Value $overrideLabel `
                                    -Set $labelSet `
                                    -DuplicateCounter (
                                        [ref]$labelDuplicatesInChunks
                                    )

                                Add-ToChunk `
                                    -Value $overrideLabel `
                                    -Set $overrideSet `
                                    -DuplicateCounter (
                                        [ref]$overrideDuplicatesInChunks
                                    )
                            }

                            if (
                                $approvedExactHosts.Contains(
                                    $hostname
                                )
                            ) {
                                Add-ToChunk `
                                    -Value $hostname `
                                    -Set $exactHostSet `
                                    -DuplicateCounter (
                                        [ref]$exactHostDuplicatesInChunks
                                    )

                                $exactHostMatches++
                                $acceptedLines++
                                $sourceAccepted++
                            }
                            elseif (
                                @($analysis.OverrideLabels).Count -gt 0
                            ) {
                                $acceptedLines++
                                $sourceAccepted++
                            }
                            else {
                                $parsed =
                                    New-ParseResult `
                                        -Reason "public-suffix-only"
                            }
                        }
                        else {
                            Add-ToChunk `
                                -Value $analysis.MainLabel `
                                -Set $labelSet `
                                -DuplicateCounter (
                                    [ref]$labelDuplicatesInChunks
                                )

                            foreach (
                                $overrideLabel in
                                @($analysis.OverrideLabels)
                            ) {
                                Add-ToChunk `
                                    -Value $overrideLabel `
                                    -Set $labelSet `
                                    -DuplicateCounter (
                                        [ref]$labelDuplicatesInChunks
                                    )

                                Add-ToChunk `
                                    -Value $overrideLabel `
                                    -Set $overrideSet `
                                    -DuplicateCounter (
                                        [ref]$overrideDuplicatesInChunks
                                    )
                            }

                            if (
                                $approvedExactHosts.Contains(
                                    $hostname
                                )
                            ) {
                                Add-ToChunk `
                                    -Value $hostname `
                                    -Set $exactHostSet `
                                    -DuplicateCounter (
                                        [ref]$exactHostDuplicatesInChunks
                                    )

                                $exactHostMatches++
                            }

                            $acceptedLines++
                            $sourceAccepted++
                        }
                    }

                    if (
                        -not $parsed.CompactLabel -and
                        -not $parsed.Hostname -and
                        $parsed.Reason
                    ) {
                        $reason =
                            [string]$parsed.Reason

                        $rejectedLines++
                        $sourceRejected++

                        if (
                            -not $rejectionReasons.ContainsKey(
                                $reason
                            )
                        ) {
                            $rejectionReasons[$reason] =
                                [long]0
                        }

                        $rejectionReasons[$reason]++

                        $rejectedWriter.WriteLine(
                            [string]::Join(
                                "`t",
                                @(
                                    $reason,
                                    $inputPath,
                                    [string]$sourceLines,
                                    (
                                        [string]$originalLine
                                    ).Replace(
                                        "`t",
                                        " "
                                    )
                                )
                            )
                        )

                        if (
                            $rejectionSamples.Count -lt
                            $MaximumRejectedSamples
                        ) {
                            [void]$rejectionSamples.Add(
                                (
                                    $reason +
                                    ": " +
                                    [string]$originalLine
                                )
                            )
                        }
                    }

                    if (
                        $labelSet.Count -ge
                        $ChunkSize
                    ) {
                        Flush-ChunkSet `
                            -Set $labelSet `
                            -TemporaryDirectory $temporaryDirectory `
                            -Prefix "labels" `
                            -ChunkNumber (
                                [ref]$labelChunkNumber
                            ) `
                            -Paths $labelChunkPaths

                        Write-StudioProgress `
                            -Text (
                                "Created label chunk {0}; processed {1:N0} lines." -f
                                $labelChunkNumber,
                                $totalLines
                            )
                    }

                    if (
                        $exactHostSet.Count -ge
                        $ChunkSize
                    ) {
                        Flush-ChunkSet `
                            -Set $exactHostSet `
                            -TemporaryDirectory $temporaryDirectory `
                            -Prefix "exact-hosts" `
                            -ChunkNumber (
                                [ref]$exactHostChunkNumber
                            ) `
                            -Paths $exactHostChunkPaths
                    }

                    if (
                        $hostSubdomainSet.Count -ge
                        $ChunkSize
                    ) {
                        Flush-ChunkSet `
                            -Set $hostSubdomainSet `
                            -TemporaryDirectory $temporaryDirectory `
                            -Prefix "host-subdomains" `
                            -ChunkNumber (
                                [ref]$hostSubdomainChunkNumber
                            ) `
                            -Paths $hostSubdomainChunkPaths
                    }

                    if (
                        $overrideSet.Count -ge
                        $ChunkSize
                    ) {
                        Flush-ChunkSet `
                            -Set $overrideSet `
                            -TemporaryDirectory $temporaryDirectory `
                            -Prefix "psl-overrides" `
                            -ChunkNumber (
                                [ref]$overrideChunkNumber
                            ) `
                            -Paths $overrideChunkPaths
                    }

                    if (
                        $totalLines % 1000000 -eq
                        0
                    ) {
                        Write-StudioProgress `
                            -Text (
                                "Processed {0:N0} lines." -f
                                $totalLines
                            )
                    }

                    if (
                        $PreviewOnly -and
                        $transformationPreview.Count -ge
                        $PreviewLimit
                    ) {
                        break
                    }
                }
            }
            finally {
                $reader.Dispose()
            }

            [void]$sourceReports.Add(
                [pscustomobject]@{
                    path = $inputPath
                    byteLength = $sourceBytes
                    sha256 = $sourceSha256
                    lines = $sourceLines
                    acceptedLines = $sourceAccepted
                    rejectedLines = $sourceRejected
                    transformedLines = $sourceChanged
                }
            )

            if (
                $PreviewOnly -and
                $transformationPreview.Count -ge
                $PreviewLimit
            ) {
                break
            }
        }

        if (-not $PreviewOnly) {
            Flush-ChunkSet `
                -Set $labelSet `
                -TemporaryDirectory $temporaryDirectory `
                -Prefix "labels" `
                -ChunkNumber (
                    [ref]$labelChunkNumber
                ) `
                -Paths $labelChunkPaths

            Flush-ChunkSet `
                -Set $exactHostSet `
                -TemporaryDirectory $temporaryDirectory `
                -Prefix "exact-hosts" `
                -ChunkNumber (
                    [ref]$exactHostChunkNumber
                ) `
                -Paths $exactHostChunkPaths

            Flush-ChunkSet `
                -Set $hostSubdomainSet `
                -TemporaryDirectory $temporaryDirectory `
                -Prefix "host-subdomains" `
                -ChunkNumber (
                    [ref]$hostSubdomainChunkNumber
                ) `
                -Paths $hostSubdomainChunkPaths

            Flush-ChunkSet `
                -Set $overrideSet `
                -TemporaryDirectory $temporaryDirectory `
                -Prefix "psl-overrides" `
                -ChunkNumber (
                    [ref]$overrideChunkNumber
                ) `
                -Paths $overrideChunkPaths
        }
    }
    finally {
        $rejectedWriter.Dispose()
        $previewWriter.Dispose()
    }

    if ($PreviewOnly) {
        $finishedAt =
            [DateTimeOffset]::UtcNow

        $previewMetadata = [ordered]@{
            format =
                "leanserp-url-transformation-preview"
            version =
                $FormatVersion
            createdAt =
                $finishedAt.ToString("o")
            replacementMode =
                $ReplacementMode
            findText =
                $FindText
            replaceText =
                $ReplaceText
            caseSensitive =
                [bool]$CaseSensitive
            previewLimit =
                $PreviewLimit
            previewCount =
                $transformationPreview.Count
            inputLinesRead =
                $totalLines
            transformedLines =
                $changedLines
            previewFile =
                (
                    Split-Path `
                        $previewOutputPath `
                        -Leaf
                )
            previewSha256 =
                Get-Sha256 `
                    -Path $previewOutputPath
        }

        [System.IO.File]::WriteAllText(
            $metadataOutputPath,
            (
                $previewMetadata |
                ConvertTo-Json -Depth 8
            ) +
            [Environment]::NewLine,
            [System.Text.UTF8Encoding]::new(
                $false
            )
        )

        Write-StudioProgress
        Write-StudioProgress `
            -Text "Transformation preview completed."
        Write-StudioProgress `
            -Text (
                "Lines read: {0:N0}" -f
                $totalLines
            )
        Write-StudioProgress `
            -Text (
                "Changed lines: {0:N0}" -f
                $changedLines
            )
        Write-StudioProgress `
            -Text "Preview:"
        Write-StudioProgress `
            -Text $previewOutputPath
        Write-StudioProgress `
            -Text "Metadata:"
        Write-StudioProgress `
            -Text $metadataOutputPath

        exit 0
    }

    if ($labelChunkPaths.Count -eq 0) {
        throw "No valid labels were produced."
    }

    Write-StudioProgress `
        -Text (
            "Merging {0:N0} label chunks..." -f
            $labelChunkPaths.Count
        )

    $labelMerge =
        Merge-SortedChunks `
            -ChunkPaths $labelChunkPaths.ToArray() `
            -OutputPath $labelsOutputPath

    Write-StudioProgress `
        -Text (
            "Merging {0:N0} exact-host chunks..." -f
            $exactHostChunkPaths.Count
        )

    $exactHostMerge =
        Merge-SortedChunks `
            -ChunkPaths $exactHostChunkPaths.ToArray() `
            -OutputPath $exactHostsOutputPath

    Write-StudioProgress `
        -Text (
            "Merging {0:N0} host-subdomain chunks..." -f
            $hostSubdomainChunkPaths.Count
        )

    $hostSubdomainMerge =
        Merge-SortedChunks `
            -ChunkPaths $hostSubdomainChunkPaths.ToArray() `
            -OutputPath $hostSubdomainsOutputPath

    Write-StudioProgress `
        -Text (
            "Merging {0:N0} PSL-override chunks..." -f
            $overrideChunkPaths.Count
        )

    $overrideMerge =
        Merge-SortedChunks `
            -ChunkPaths $overrideChunkPaths.ToArray() `
            -OutputPath $pslOverridesOutputPath

    $finishedAt =
        [DateTimeOffset]::UtcNow

    $filesMetadata = [ordered]@{}

    foreach ($fileInfo in @(
        [pscustomobject]@{
            Name = "labels.txt"
            Path = $labelsOutputPath
            Count = $labelMerge.OutputCount
            Duplicates =
                $labelDuplicatesInChunks +
                $labelMerge.DuplicatesRemoved
        }
        [pscustomobject]@{
            Name = "exact-host-blocks.txt"
            Path = $exactHostsOutputPath
            Count = $exactHostMerge.OutputCount
                        Duplicates =
                $exactHostDuplicatesInChunks +
                $exactHostMerge.DuplicatesRemoved
        }
        [pscustomobject]@{
            Name = "host-subdomain-blocks.txt"
            Path = $hostSubdomainsOutputPath
            Count =
                $hostSubdomainMerge.OutputCount
            Duplicates =
                $hostSubdomainDuplicatesInChunks +
                $hostSubdomainMerge.DuplicatesRemoved
        }
        [pscustomobject]@{
            Name = "psl-label-overrides.txt"
            Path = $pslOverridesOutputPath
            Count = $overrideMerge.OutputCount
            Duplicates =
                $overrideDuplicatesInChunks +
                $overrideMerge.DuplicatesRemoved
        }
        [pscustomobject]@{
            Name = "rejected-lines.tsv"
            Path = $rejectedOutputPath
            Count = $rejectedLines
            Duplicates = 0
        }
        [pscustomobject]@{
            Name = "transformation-preview.tsv"
            Path = $previewOutputPath
            Count =
                $transformationPreview.Count
            Duplicates = 0
        }
    )) {
        $filesMetadata[
            $fileInfo.Name
        ] = [ordered]@{
            count =
                $fileInfo.Count
            duplicatesRemoved =
                $fileInfo.Duplicates
            byteLength =
                (
                    Get-Item `
                        -LiteralPath $fileInfo.Path
                ).Length
            sha256 =
                Get-Sha256 `
                    -Path $fileInfo.Path
        }
    }
    $metadata = [ordered]@{
        format =
            $FormatName
        version =
            $FormatVersion
        createdAt =
            $finishedAt.ToString("o")
        durationSeconds =
            [math]::Round(
                (
                    $finishedAt -
                    $startedAt
                ).TotalSeconds,
                3
            )
        encoding = "utf-8"
        sorted = $true
        deduplicated = $true
        keepUnderscores =
            [bool]$KeepUnderscores
        removeCommonWwwLabels =
            [bool]$RemoveCommonWwwLabels
        replacement = [ordered]@{
            mode =
                $ReplacementMode
            findText =
                $FindText
            replaceText =
                $ReplaceText
            caseSensitive =
                [bool]$CaseSensitive
            changedLines =
                $changedLines
        }
        publicSuffixList = [ordered]@{
            path =
                (
                    Resolve-Path `
                        -LiteralPath $PublicSuffixList
                ).Path
            sha256 =
                Get-Sha256 `
                    -Path $PublicSuffixList
            ruleCount =
                $publicSuffixRules.RuleCount
        }
        approvedRules = [ordered]@{
            exactHostCount =
                $approvedExactHosts.Count
            pslOverrideCount =
                $approvedPslOverrides.Count
            exactHostSource =
                $exactHostRulesPath
            pslOverrideSource =
                $pslOverrideRulesPath
        }
        sourceCount =
            $sourceReports.Count
        sources =
            $sourceReports
        statistics = [ordered]@{
            inputLines =
                $totalLines
            acceptedLines =
                $acceptedLines
            rejectedLines =
                $rejectedLines
            transformedLines =
                $changedLines
            compactLabelLines =
                $compactLabelLines
            hostnameLines =
                $hostnameLines
            publicSuffixOnlyLines =
                $publicSuffixOnlyLines
            approvedExactHostMatches =
                $exactHostMatches
        }
        rejectionReasons =
            $rejectionReasons
        rejectionSamples =
            $rejectionSamples
        files =
            $filesMetadata
    }
    [System.IO.File]::WriteAllText(
        $metadataOutputPath,
        (
            $metadata |
            ConvertTo-Json -Depth 15
        ) +
        [Environment]::NewLine,
        [System.Text.UTF8Encoding]::new(
            $false
        )
    )
    if (-not $KeepTemporaryFiles) {
        Remove-Item `
            -LiteralPath $temporaryDirectory `
            -Recurse `
            -Force
    }
    Write-StudioProgress
    Write-StudioProgress `
        -Text "LeanSERP URL build completed."
    Write-StudioProgress `
        -Text (
            "Input lines: {0:N0}" -f
            $totalLines
        )
    Write-StudioProgress `
        -Text (
            "Accepted lines: {0:N0}" -f
            $acceptedLines
        )
    Write-StudioProgress `
        -Text (
            "Rejected lines: {0:N0}" -f
            $rejectedLines
        )
    Write-StudioProgress `
        -Text (
            "Unique labels: {0:N0}" -f
            $labelMerge.OutputCount
        )
    Write-StudioProgress `
        -Text (
            "Exact-host blocks: {0:N0}" -f
            $exactHostMerge.OutputCount
        )
    Write-StudioProgress `
        -Text (
            "Host-subdomain blocks: {0:N0}" -f
            $hostSubdomainMerge.OutputCount
        )
    Write-StudioProgress `
        -Text (
            "PSL label overrides: {0:N0}" -f
            $overrideMerge.OutputCount
        )
    Write-StudioProgress `
        -Text "Package:"
    Write-StudioProgress `
        -Text $buildDirectory
    Write-StudioProgress `
        -Text "Metadata:"
    Write-StudioProgress `
        -Text $metadataOutputPath
}
finally {
    Close-ProgressWriter
}
exit 0

