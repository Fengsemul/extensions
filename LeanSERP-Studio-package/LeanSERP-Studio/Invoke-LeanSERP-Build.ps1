[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$BuilderPath,

    [Parameter(Mandatory = $false)]
    [string[]]$InputFile = @(),
        
    [Parameter(Mandatory = $false)]
    [string]$InputListFile = "",

    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory,

    [Parameter(Mandatory = $true)]
    [string]$LogPath,

    [Parameter(Mandatory = $false)]
    [ValidateRange(1000, 1000000)]
    [int]$ChunkSize = 250000,

    [Parameter(Mandatory = $false)]
    [switch]$KeepUnderscores,

    [Parameter(Mandatory = $false)]
    [switch]$KeepTemporaryFiles
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

function Write-LogHeader {
    param(
        [Parameter(Mandatory = $true)]
        [System.IO.StreamWriter]$Writer,

        [Parameter(Mandatory = $true)]
        [string]$ResolvedBuilder,

        [Parameter(Mandatory = $true)]
        [string]$ResolvedOutput,

        [Parameter(Mandatory = $true)]
        [string[]]$ResolvedInputs,

        [Parameter(Mandatory = $true)]
        [DateTimeOffset]$StartedAt
    )

    $Writer.WriteLine(
        "LeanSERP build runner started."
    )
    $Writer.WriteLine(
        "Started UTC: " +
        $StartedAt.ToString("o")
    )
    $Writer.WriteLine(
        "Builder: " +
        $ResolvedBuilder
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
            "  " +
            $path
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
        "Keep temporary files: " +
        [string][bool]$KeepTemporaryFiles
    )
    $Writer.WriteLine("")
    $Writer.Flush()
}

function Write-LogError {
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
            "BUILD ERROR"
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

function Write-LogFooter {
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
            "LeanSERP build runner finished."
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
            -LiteralPath $BuilderPath `
            -PathType Leaf
    )
) {
    throw "Builder not found: $BuilderPath"
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
        throw "Input-list file not found: $InputListFile"
    }

    $listReader =
        [System.IO.StreamReader]::new(
            $InputListFile,
            [System.Text.UTF8Encoding]::new(
                $false
            ),
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

$InputFile = $combinedInputs.ToArray()


$resolvedInputs =
    [System.Collections.Generic.List[string]]::new()

foreach ($path in $InputFile) {
    if (
        -not (
            Test-Path `
                -LiteralPath $path `
                -PathType Leaf
        )
    ) {
        throw "Input file not found: $path"
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
    throw "The log path has no parent directory."
}

[void](
    New-Item `
        -ItemType Directory `
        -Path $logDirectory `
        -Force
)

$resolvedBuilder = (
    Resolve-Path `
        -LiteralPath $BuilderPath
).Path

$resolvedOutput = (
    Resolve-Path `
        -LiteralPath $OutputDirectory
).Path

$startedAt =
    [DateTimeOffset]::UtcNow

$exitCode = 0
$headerWriter = $null

try {
    $headerWriter =
        New-Utf8Writer `
            -Path $LogPath `
            -Append $false

    Write-LogHeader `
        -Writer $headerWriter `
        -ResolvedBuilder $resolvedBuilder `
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
    InputFile = $resolvedInputs.ToArray()
    OutputDirectory = $resolvedOutput
    ChunkSize = $ChunkSize
    ProgressLogPath = $LogPath
}

if ($KeepUnderscores) {
    $parameters["KeepUnderscores"] =
        $true
}

if ($KeepTemporaryFiles) {
    $parameters["KeepTemporaryFiles"] =
        $true
}

try {
    & $resolvedBuilder @parameters

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
        Write-LogError `
            -Text $errorText
    }
    catch {
    }

    Write-Error $errorText
}
finally {
    try {
        Write-LogFooter `
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
