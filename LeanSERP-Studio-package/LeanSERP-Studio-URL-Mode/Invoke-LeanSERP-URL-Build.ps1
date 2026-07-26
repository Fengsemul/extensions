[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$NormalizerPath,

    [Parameter(Mandatory = $false)]
    [string[]]$InputFile = @(),

    [Parameter(Mandatory = $false)]
    [string]$InputListFile = "",

    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory,

    [Parameter(Mandatory = $true)]
    [string]$LogPath,

    [Parameter(Mandatory = $false)]
    [string]$PublicSuffixList = "",

    [Parameter(Mandatory = $false)]
    [string]$ApprovedRulesDirectory = "",

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
    [int]$PreviewLimit = 100
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

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
        [System.Text.UTF8Encoding]::new($false),
        4096
    )
}

function Write-RunnerHeader {
    param(
        [Parameter(Mandatory = $true)]
        [System.IO.StreamWriter]$Writer,

        [Parameter(Mandatory = $true)]
        [string]$ResolvedNormalizer,

        [Parameter(Mandatory = $true)]
        [string]$ResolvedOutput,

        [Parameter(Mandatory = $true)]
        [string[]]$ResolvedInputs,

        [Parameter(Mandatory = $true)]
        [DateTimeOffset]$StartedAt
    )

    $Writer.WriteLine(
        "LeanSERP URL build runner started."
    )
    $Writer.WriteLine(
        "Started UTC: " +
        $StartedAt.ToString("o")
    )
    $Writer.WriteLine(
        "Normalizer: " +
        $ResolvedNormalizer
    )
    $Writer.WriteLine(
        "Output directory: " +
        $ResolvedOutput
    )
    $Writer.WriteLine(
        "Input files: " +
        $ResolvedInputs.Count
    )

    foreach ($path in $ResolvedInputs) {
        $Writer.WriteLine(
            "  " + $path
        )
    }

    $Writer.WriteLine(
        "Chunk size: " +
        $ChunkSize
    )
    $Writer.WriteLine(
        "Keep underscores: " +
        [string][bool]$KeepUnderscores
    )
    $Writer.WriteLine(
        "Remove common www labels: " +
        [string][bool]$RemoveCommonWwwLabels
    )
    $Writer.WriteLine(
        "Keep temporary files: " +
        [string][bool]$KeepTemporaryFiles
    )
    $Writer.WriteLine(
        "Replacement mode: " +
        $ReplacementMode
    )
    $Writer.WriteLine(
        "Case sensitive: " +
        [string][bool]$CaseSensitive
    )
    $Writer.WriteLine(
        "Preview only: " +
        [string][bool]$PreviewOnly
    )
    $Writer.WriteLine(
        "Preview limit: " +
        $PreviewLimit
    )
    $Writer.WriteLine("")
    $Writer.Flush()
}

function Write-RunnerError {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Text
    )

    $writer = $null

    try {
        $writer =
            New-Utf8Writer `
                -Path $LogPath `
                -Append $true

        $writer.WriteLine("")
        $writer.WriteLine(
            "URL BUILD ERROR"
        )
        $writer.WriteLine(
            $Text.TrimEnd()
        )
        $writer.Flush()
    }
    finally {
        if ($null -ne $writer) {
            $writer.Dispose()
        }
    }
}

function Write-RunnerFooter {
    param(
        [Parameter(Mandatory = $true)]
        [DateTimeOffset]$StartedAt,

        [Parameter(Mandatory = $true)]
        [int]$ExitCode
    )

    $finishedAt =
        [DateTimeOffset]::UtcNow

    $durationSeconds =
        [math]::Round(
            (
                $finishedAt -
                $StartedAt
            ).TotalSeconds,
            3
        )

    $writer = $null

    try {
        $writer =
            New-Utf8Writer `
                -Path $LogPath `
                -Append $true

        $writer.WriteLine("")
        $writer.WriteLine(
            "LeanSERP URL build runner finished."
        )
        $writer.WriteLine(
            "Finished UTC: " +
            $finishedAt.ToString("o")
        )
        $writer.WriteLine(
            "Duration seconds: " +
            $durationSeconds
        )
        $writer.WriteLine(
            "Exit code: " +
            $ExitCode
        )
        $writer.Flush()
    }
    finally {
        if ($null -ne $writer) {
            $writer.Dispose()
        }
    }
}

if (
    -not (
        Test-Path `
            -LiteralPath $NormalizerPath `
            -PathType Leaf
    )
) {
    throw (
        "URL normalizer not found: " +
        $NormalizerPath
    )
}

$combinedInputs =
    [System.Collections.Generic.List[string]]::new()

if ($InputFile) {
    foreach ($path in $InputFile) {
        if (
            -not [string]::IsNullOrWhiteSpace(
                $path
            )
        ) {
            [void]$combinedInputs.Add(
                $path
            )
        }
    }
}

if (
    -not [string]::IsNullOrWhiteSpace(
        $InputListFile
    )
) {
    if (
        -not (
            Test-Path `
                -LiteralPath $InputListFile `
                -PathType Leaf
        )
    ) {
        throw (
            "Input-list file not found: " +
            $InputListFile
        )
    }

    $listReader =
        [System.IO.StreamReader]::new(
            $InputListFile,
            [System.Text.UTF8Encoding]::new($false),
            $true,
            65536
        )

    try {
        while (
            -not $listReader.EndOfStream
        ) {
            $listedPath =
                $listReader.ReadLine()

            if (
                -not [string]::IsNullOrWhiteSpace(
                    $listedPath
                )
            ) {
                [void]$combinedInputs.Add(
                    $listedPath.Trim()
                )
            }
        }
    }
    finally {
        $listReader.Dispose()
    }
}

if ($combinedInputs.Count -eq 0) {
    throw "No input files were supplied."
}

$resolvedInputs =
    [System.Collections.Generic.List[string]]::new()

foreach ($path in $combinedInputs) {
    if (
        -not (
            Test-Path `
                -LiteralPath $path `
                -PathType Leaf
        )
    ) {
        throw (
            "Input file not found: " +
            $path
        )
    }

    $resolvedPath = (
        Resolve-Path `
            -LiteralPath $path
    ).Path

    if (
        -not $resolvedInputs.Contains(
            $resolvedPath
        )
    ) {
        [void]$resolvedInputs.Add(
            $resolvedPath
        )
    }
}

[void](
    New-Item `
        -ItemType Directory `
        -Path $OutputDirectory `
        -Force
)

$logDirectory =
    Split-Path `
        -Parent $LogPath

if (
    [string]::IsNullOrWhiteSpace(
        $logDirectory
    )
) {
    throw (
        "The log path has no parent directory."
    )
}

[void](
    New-Item `
        -ItemType Directory `
        -Path $logDirectory `
        -Force
)

$resolvedNormalizer = (
    Resolve-Path `
        -LiteralPath $NormalizerPath
).Path

$resolvedOutput = (
    Resolve-Path `
        -LiteralPath $OutputDirectory
).Path

if (
    -not [string]::IsNullOrWhiteSpace(
        $PublicSuffixList
    )
) {
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

    $PublicSuffixList = (
        Resolve-Path `
            -LiteralPath $PublicSuffixList
    ).Path
}

if (
    -not [string]::IsNullOrWhiteSpace(
        $ApprovedRulesDirectory
    )
) {
    if (
        -not (
            Test-Path `
                -LiteralPath $ApprovedRulesDirectory `
                -PathType Container
        )
    ) {
        throw (
            "Approved-rules directory not found: " +
            $ApprovedRulesDirectory
        )
    }

    $ApprovedRulesDirectory = (
        Resolve-Path `
            -LiteralPath $ApprovedRulesDirectory
    ).Path
}

$startedAt =
    [DateTimeOffset]::UtcNow

$exitCode = 0
$headerWriter = $null

try {
    $headerWriter =
        New-Utf8Writer `
            -Path $LogPath `
            -Append $false

    Write-RunnerHeader `
        -Writer $headerWriter `
        -ResolvedNormalizer $resolvedNormalizer `
        -ResolvedOutput $resolvedOutput `
        -ResolvedInputs $resolvedInputs.ToArray() `
        -StartedAt $startedAt
}
finally {
    if ($null -ne $headerWriter) {
        $headerWriter.Dispose()
        $headerWriter = $null
    }
}

$parameters = @{
    InputFile =
        $resolvedInputs.ToArray()
    OutputDirectory =
        $resolvedOutput
    ChunkSize =
        $ChunkSize
    ReplacementMode =
        $ReplacementMode
    FindText =
        $FindText
    ReplaceText =
        $ReplaceText
    PreviewLimit =
        $PreviewLimit
    ProgressLogPath =
        $LogPath
}

if (
    -not [string]::IsNullOrWhiteSpace(
        $PublicSuffixList
    )
) {
    $parameters[
        "PublicSuffixList"
    ] = $PublicSuffixList
}

if (
    -not [string]::IsNullOrWhiteSpace(
        $ApprovedRulesDirectory
    )
) {
    $parameters[
        "ApprovedRulesDirectory"
    ] = $ApprovedRulesDirectory
}

if ($KeepUnderscores) {
    $parameters[
        "KeepUnderscores"
    ] = $true
}

if ($RemoveCommonWwwLabels) {
    $parameters[
        "RemoveCommonWwwLabels"
    ] = $true
}

if ($KeepTemporaryFiles) {
    $parameters[
        "KeepTemporaryFiles"
    ] = $true
}

if ($CaseSensitive) {
    $parameters[
        "CaseSensitive"
    ] = $true
}

if ($PreviewOnly) {
    $parameters[
        "PreviewOnly"
    ] = $true
}

try {
    & $resolvedNormalizer @parameters

    if (-not $?) {
        $exitCode = 1
    }
}
catch {
    $exitCode = 1

    $errorText =
        $_ |
        Out-String

    try {
        Write-RunnerError `
            -Text $errorText
    }
    catch {
    }

    Write-Error $errorText
}
finally {
    try {
        Write-RunnerFooter `
            -StartedAt $startedAt `
            -ExitCode $exitCode
    }
    catch {
    }
}

if ($exitCode -ne 0) {
    exit $exitCode
}

exit 0
$path = "C:\Users\PC\Downloads\LeanSERP-Studio-URL-Mode\Invoke-LeanSERP-URL-Build.ps1"
if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "Invoke-LeanSERP-URL-Build.ps1 does not exist."
}
$tokens = $null
$errors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile(
    $path,
    [ref]$tokens,
    [ref]$errors
)
if ($errors.Count -gt 0) {
    $errors |
        Select-Object @{
            Name = "Line"
            Expression = {
                $_.Extent.StartLineNumber
            }
        }, ErrorId, Message |
        Format-Table -Wrap
    throw "The URL runner contains syntax errors."
}
$text = Get-Content -LiteralPath $path -Raw
$length = (Get-Item -LiteralPath $path).Length
if ($length -lt 8000) {
    throw "The URL runner may be incomplete: $length bytes."
}
$required = @(
    '$InputListFile = ""',
    'function Write-RunnerHeader',
    'function Write-RunnerError',
    'function Write-RunnerFooter',
    '$combinedInputs =',
    'ProgressLogPath =',
    'RemoveCommonWwwLabels',
    'ReplacementMode',
    'PreviewOnly',
    '& $resolvedNormalizer @parameters',
    'LeanSERP URL build runner started.',
    'LeanSERP URL build runner finished.'
)
foreach ($item in $required) {
    if (-not $text.Contains($item)) {
        throw "Missing URL-runner component: $item"
    }
}
if ($text -match '\bTee-Object\b') {
    throw "The URL runner must not use Tee-Object."
}
if ($text -match '\[[^\]]+\]\(https?://') {
    throw "Markdown-link contamination was detected."
}
if ($text -match '(?m)^\s*```') {
    throw "A copied code-fence line was detected."
}
Write-Host "LeanSERP URL runner passed validation." -ForegroundColor Green
Write-Host "File size: $length bytes." -ForegroundColor Green
