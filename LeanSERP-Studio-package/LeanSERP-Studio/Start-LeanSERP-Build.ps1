[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms

$studioDirectory =
    "C:\Users\PC\Downloads\LeanSERP-Studio"

$builderPath =
    Join-Path $studioDirectory "LeanSERP-Studio.ps1"

$defaultOutput =
    "C:\Users\PC\Downloads\LeanSERP-Output"

if (
    -not (
        Test-Path `
            -LiteralPath $builderPath `
            -PathType Leaf
    )
) {
    throw "LeanSERP-Studio.ps1 was not found."
}

$fileDialog =
    [System.Windows.Forms.OpenFileDialog]::new()

$fileDialog.Title =
    "Select LeanSERP source files"

$fileDialog.Filter =
    "Text and list files|*.txt;*.list;*.dat|All files|*.*"

$fileDialog.Multiselect = $true
$fileDialog.CheckFileExists = $true

try {
    if (
        $fileDialog.ShowDialog() -ne
        [System.Windows.Forms.DialogResult]::OK
    ) {
        Write-Host "No source files selected."
        exit 0
    }

    $inputFiles = @($fileDialog.FileNames)
}
finally {
    $fileDialog.Dispose()
}

$folderDialog =
    [System.Windows.Forms.FolderBrowserDialog]::new()

$folderDialog.Description =
    "Select the LeanSERP output directory"

$folderDialog.SelectedPath =
    $defaultOutput

try {
    if (
        $folderDialog.ShowDialog() -eq
        [System.Windows.Forms.DialogResult]::OK
    ) {
        $outputDirectory =
            $folderDialog.SelectedPath
    }
    else {
        $outputDirectory =
            $defaultOutput
    }
}
finally {
    $folderDialog.Dispose()
}

New-Item `
    -ItemType Directory `
    -Path $outputDirectory `
    -Force |
    Out-Null

$timestamp =
    Get-Date -Format "yyyyMMdd-HHmmss"

$logDirectory =
    Join-Path $outputDirectory "logs"

New-Item `
    -ItemType Directory `
    -Path $logDirectory `
    -Force |
    Out-Null

$logPath =
    Join-Path `
        $logDirectory `
        ("console-build-" + $timestamp + ".log")

$arguments =
    [System.Collections.Generic.List[string]]::new()

[void]$arguments.Add(
    "-NoProfile"
)

[void]$arguments.Add(
    "-ExecutionPolicy"
)

[void]$arguments.Add(
    "Bypass"
)

[void]$arguments.Add(
    "-NoExit"
)

[void]$arguments.Add(
    "-Command"
)

$commandParts =
    [System.Collections.Generic.List[string]]::new()

[void]$commandParts.Add(
    "& '" +
    $builderPath.Replace("'", "''") +
    "'"
)

foreach ($inputFile in $inputFiles) {
    [void]$commandParts.Add(
        "-InputFile '" +
        $inputFile.Replace("'", "''") +
        "'"
    )
}

[void]$commandParts.Add(
    "-OutputDirectory '" +
    $outputDirectory.Replace("'", "''") +
    "'"
)

[void]$commandParts.Add(
    "-ChunkSize 250000"
)

[void]$commandParts.Add(
    "-KeepUnderscores"
)

$buildCommand =
    $commandParts -join " "

$wrappedCommand =
    "& { " +
    $buildCommand +
    " } *>&1 | Tee-Object -FilePath '" +
    $logPath.Replace("'", "''") +
    "'; " +
    "Write-Host ''; " +
    "Write-Host 'LeanSERP build process finished.' " +
    "-ForegroundColor Cyan; " +
    "Write-Host 'Log: " +
    $logPath.Replace("'", "''") +
    "'"

[void]$arguments.Add(
    $wrappedCommand
)

$quotedArguments = @(
    $arguments |
        ForEach-Object {
            '"' +
            $_.Replace('"', '\"') +
            '"'
        }
)

$argumentString =
    $quotedArguments -join " "

$startInfo =
    [System.Diagnostics.ProcessStartInfo]::new()

$startInfo.FileName =
    "powershell.exe"

$startInfo.Arguments =
    $argumentString

$startInfo.UseShellExecute =
    $true

$startInfo.WorkingDirectory =
    $studioDirectory

$process =
    [System.Diagnostics.Process]::Start(
        $startInfo
    )

if ($null -eq $process) {
    throw "Could not open the build console."
}

Write-Host "LeanSERP build console opened." -ForegroundColor Green
Write-Host "Process ID: $($process.Id)"
Write-Host "Log: $logPath"
