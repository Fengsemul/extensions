[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$scriptPath = $MyInvocation.MyCommand.Path
$scriptDirectory = Split-Path -Parent $scriptPath
$normalizerPath = Join-Path $scriptDirectory "bin\Release\net8.0\LeanSerpUrlNormalizer.exe"
$postprocessorPath = Join-Path $scriptDirectory "bin\Release\net8.0\ApplyApprovedOverrides.exe"
$packageGeneratorPath = Join-Path $scriptDirectory "New-LeanSerpPackage.ps1"
$pslPath = Join-Path $scriptDirectory "public_suffix_list.dat"
$approvedRulesDirectory = Join-Path $scriptDirectory "Approved-Rules"
$hostSubdomainRulesPath = Join-Path $scriptDirectory "PSL-Host-Review\Approved-Exact-Hosts\approved-psl-host-subdomains.txt"
$defaultCompiledOutput = Join-Path $env:USERPROFILE "Downloads\LeanSERP-Compiled-Output"
$defaultApprovedOutput = Join-Path $env:USERPROFILE "Downloads\LeanSERP-Compiled-Approved-Output"
$defaultPackageOutput = Join-Path $env:USERPROFILE "Downloads\LeanSERP-Packages"
$defaultLogDirectory = Join-Path $scriptDirectory "GUI-Logs"
$selectedFiles = [System.Collections.Generic.List[string]]::new()
$script:activeProcess = $null
$script:activeStage = "Idle"
$script:stopRequested = $false
$script:activeInputListPath = ""
$script:activeLogPath = ""
$script:displayedLogLineCount = 0
$script:compiledBuildPath = ""
$script:approvedBuildPath = ""
$script:packagePath = ""
$script:buildStartedAt = $null
function New-Button {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Text,
        [Parameter(Mandatory = $false)]
        [int]$Width = 145
    )
    $button = [System.Windows.Forms.Button]::new()
    $button.Text = $Text
    $button.Width = $Width
    $button.Height = 34
    $button.Margin = [System.Windows.Forms.Padding]::new(0, 0, 8, 8)
    return $button
}
function Set-ClipboardText {
    param(
        [AllowEmptyString()]
        [string]$Text,
        [Parameter(Mandatory = $true)]
        [string]$Description
    )
    if ([string]::IsNullOrWhiteSpace($Text)) {
        [void][System.Windows.Forms.MessageBox]::Show(
            "There is no $Description to copy.",
            "LeanSERP Studio",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Information
        )
        return
    }
    try {
        [System.Windows.Forms.Clipboard]::SetText($Text)
    }
    catch {
        [void][System.Windows.Forms.MessageBox]::Show(
            "Could not copy the ${Description}:`r`n$($_.Exception.Message)",
            "LeanSERP Studio",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error
        )
    }
}
function Quote-NativeArgument {
    param(
        [AllowEmptyString()]
        [string]$Value
    )
    if ($null -eq $Value) {
        return '""'
    }
    if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') {
        return $Value
    }
    $escaped = $Value -replace '(\\*)"', '$1$1\"'
    $escaped = $escaped -replace '(\\+)$', '$1$1'
    return '"' + $escaped + '"'
}
function Test-ProcessRunning {
    if ($null -eq $script:activeProcess) {
        return $false
    }
    try {
        return -not $script:activeProcess.HasExited
    }
    catch {
        return $false
    }
}
function Stop-ProcessTree {
    param(
        [Parameter(Mandatory = $true)]
        [int]$ProcessId
    )
    $children = @(
        Get-CimInstance -ClassName Win32_Process -Filter "ParentProcessId=$ProcessId" -ErrorAction SilentlyContinue
    )
    foreach ($child in $children) {
        Stop-ProcessTree -ProcessId $child.ProcessId
    }
    try {
        Stop-Process -Id $ProcessId -Force -ErrorAction Stop
    }
    catch {
    }
}
function Get-NewestDirectory {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Root,
        [Parameter(Mandatory = $true)]
        [string]$Pattern,
        [Parameter(Mandatory = $true)]
        [datetime]$CreatedAfter
    )
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
        return $null
    }
    return @(
        Get-ChildItem -LiteralPath $Root -Directory -ErrorAction SilentlyContinue |
            Where-Object {
                $_.Name -like $Pattern -and
                $_.CreationTime -ge $CreatedAfter.AddSeconds(-5)
            } |
            Sort-Object LastWriteTime -Descending
    ) | Select-Object -First 1
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
function Test-RequiredFiles {
    $required = @(
        $normalizerPath
        $postprocessorPath
        $packageGeneratorPath
        $pslPath
        $approvedRulesDirectory
        $hostSubdomainRulesPath
    )
    foreach ($path in $required) {
        if (-not (Test-Path -LiteralPath $path)) {
            throw "Required component was not found: $path"
        }
    }
}
function Update-FileList {
    $fileList.BeginUpdate()
    try {
        $fileList.Items.Clear()
        foreach ($path in $selectedFiles) {
            [void]$fileList.Items.Add($path)
        }
    }
    finally {
        $fileList.EndUpdate()
    }
    $suffix = if ($selectedFiles.Count -eq 1) {
        ""
    }
    else {
        "s"
    }
    $fileCountTextBox.Text = "{0:N0} file{1} selected" -f $selectedFiles.Count, $suffix
    $copyFilesButton.Enabled = $selectedFiles.Count -gt 0
}
function Set-InterfaceRunning {
    param(
        [Parameter(Mandatory = $true)]
        [bool]$Running
    )
    $addFilesButton.Enabled = -not $Running
    $removeFilesButton.Enabled = -not $Running
    $clearFilesButton.Enabled = -not $Running
    $copyFilesButton.Enabled = -not $Running -and $selectedFiles.Count -gt 0
    $compiledOutputTextBox.Enabled = -not $Running
    $approvedOutputTextBox.Enabled = -not $Running
    $packageOutputTextBox.Enabled = -not $Running
    $browseCompiledButton.Enabled = -not $Running
    $browseApprovedButton.Enabled = -not $Running
    $browsePackageButton.Enabled = -not $Running
    $chunkNumeric.Enabled = -not $Running
    $keepUnderscoresCheckBox.Enabled = -not $Running
    $removeWwwCheckBox.Enabled = -not $Running
    $buildButton.Enabled = -not $Running
    $stopButton.Enabled = $Running
    $verifyPackageButton.Enabled = -not $Running
    $openPackageButton.Enabled = -not $Running
    $openReviewButton.Enabled = -not $Running
    $copyInterfaceButton.Enabled = $true
    if ($Running) {
        $progressBar.Style = [System.Windows.Forms.ProgressBarStyle]::Marquee
        $progressBar.MarqueeAnimationSpeed = 30
    }
    else {
        $progressBar.MarqueeAnimationSpeed = 0
        $progressBar.Style = [System.Windows.Forms.ProgressBarStyle]::Continuous
        $progressBar.Value = 0
    }
}
function Refresh-Log {
    if (
        [string]::IsNullOrWhiteSpace($script:activeLogPath) -or
        -not (Test-Path -LiteralPath $script:activeLogPath -PathType Leaf)
    ) {
        return
    }
    try {
        $lines = @(
            Get-Content -LiteralPath $script:activeLogPath -ErrorAction Stop
        )
        $lineCount = @($lines).Count
        if ($lineCount -lt $script:displayedLogLineCount) {
            $script:displayedLogLineCount = 0
            $logTextBox.Clear()
        }
        if ($lineCount -le $script:displayedLogLineCount) {
            return
        }
        $first = [int]$script:displayedLogLineCount
        $last = [int]$lineCount - 1
        $newLines = if ($first -eq $last) {
            @($lines[$first])
        }
        else {
            @($lines[$first..$last])
        }
        $newText = ($newLines -join [Environment]::NewLine) + [Environment]::NewLine
        $logTextBox.AppendText($newText)
        $logTextBox.SelectionStart = $logTextBox.TextLength
        $logTextBox.ScrollToCaret()
        $script:displayedLogLineCount = $lineCount
        $copyLogButton.Enabled = $lineCount -gt 0
    }
    catch {
        $statusTextBox.Text = "Log refresh error: $($_.Exception.Message)"
    }
}
function Start-NativeStage {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Executable,
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,
        [Parameter(Mandatory = $true)]
        [string]$Stage
    )
    $quotedArguments = @(
        foreach ($argument in $Arguments) {
            Quote-NativeArgument -Value $argument
        }
    )
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $Executable
    $startInfo.Arguments = $quotedArguments -join " "
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    try {
        [void]$process.Start()
    }
    catch {
        $process.Dispose()
        throw
    }
    $script:activeProcess = $process
    $script:activeStage = $Stage
    return $process
}
function Invoke-StageAndCapture {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Executable,
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,
        [Parameter(Mandatory = $true)]
        [string]$Stage
    )
    $process = Start-NativeStage -Executable $Executable -Arguments $Arguments -Stage $Stage
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    $exitCode = $process.ExitCode
    $process.Dispose()
    $script:activeProcess = $null

    if (-not [string]::IsNullOrEmpty($stdout)) {
        [System.IO.File]::AppendAllText(
            $script:activeLogPath,
            $stdout,
            [System.Text.UTF8Encoding]::new($false)
        )
    }

    if (-not [string]::IsNullOrEmpty($stderr)) {
        [System.IO.File]::AppendAllText(
            $script:activeLogPath,
            $stderr,
            [System.Text.UTF8Encoding]::new($false)
        )
    }

    Refresh-Log

    if ($exitCode -ne 0) {
        throw "$Stage failed with exit code $exitCode."
    }

    return [pscustomobject]@{
        ExitCode = $exitCode
        StandardOutput = $stdout
        StandardError = $stderr
    }
}

function Start-CompiledPipeline {
    if ($selectedFiles.Count -eq 0) {
        [void][System.Windows.Forms.MessageBox]::Show(
            "Add at least one source file first.",
            "LeanSERP Studio",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Information
        )
        return
    }

    Test-RequiredFiles

    $compiledOutput = $compiledOutputTextBox.Text.Trim()
    $approvedOutput = $approvedOutputTextBox.Text.Trim()
    $packageOutput = $packageOutputTextBox.Text.Trim()

    foreach ($directory in @(
        $compiledOutput
        $approvedOutput
        $packageOutput
        $defaultLogDirectory
    )) {
        if ([string]::IsNullOrWhiteSpace($directory)) {
            throw "An output directory is empty."
        }

        [void](New-Item -ItemType Directory -Path $directory -Force)
    }

    $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $script:activeInputListPath = Join-Path $defaultLogDirectory ("compiled-inputs-" + $timestamp + ".txt")
    $script:activeLogPath = Join-Path $defaultLogDirectory ("compiled-pipeline-" + $timestamp + ".log")
    $script:displayedLogLineCount = 0
    $script:compiledBuildPath = ""
    $script:approvedBuildPath = ""
    $script:packagePath = ""
    $script:buildStartedAt = Get-Date
    $script:stopRequested = $false

    [System.IO.File]::WriteAllLines(
        $script:activeInputListPath,
        [string[]]$selectedFiles.ToArray(),
        [System.Text.UTF8Encoding]::new($false)
    )

    [System.IO.File]::WriteAllText(
        $script:activeLogPath,
        "",
        [System.Text.UTF8Encoding]::new($false)
    )

    $logTextBox.Clear()
    $statusTextBox.Text = "Starting compiled normalization..."
    Set-InterfaceRunning -Running $true

    $pipelineScript = Join-Path $defaultLogDirectory ("compiled-pipeline-" + $timestamp + ".ps1")

    $inputListLiteral = $script:activeInputListPath.Replace("'", "''")
    $normalizerLiteral = $normalizerPath.Replace("'", "''")
    $postprocessorLiteral = $postprocessorPath.Replace("'", "''")
    $packageGeneratorLiteral = $packageGeneratorPath.Replace("'", "''")
    $pslLiteral = $pslPath.Replace("'", "''")
    $approvedRulesLiteral = $approvedRulesDirectory.Replace("'", "''")
    $hostSubdomainsLiteral = $hostSubdomainRulesPath.Replace("'", "''")
    $compiledOutputLiteral = $compiledOutput.Replace("'", "''")
    $approvedOutputLiteral = $approvedOutput.Replace("'", "''")
    $packageOutputLiteral = $packageOutput.Replace("'", "''")
    $logLiteral = $script:activeLogPath.Replace("'", "''")
    $chunkSize = [int]$chunkNumeric.Value
    $keepUnderscoresLiteral = if ($keepUnderscoresCheckBox.Checked) {
        '$true'
    }
    else {
        '$false'
    }
    $removeWwwLiteral = if ($removeWwwCheckBox.Checked) {
        '$true'
    }
    else {
        '$false'
    }

    $pipelineCode = @"
Set-StrictMode -Version Latest
`$ErrorActionPreference = "Stop"
`$logPath = '$logLiteral'
`$encoding = [System.Text.UTF8Encoding]::new(`$false)

function Write-PipelineLog {
    param(
        [AllowEmptyString()]
        [string]`$Text = ""
    )

    [System.IO.File]::AppendAllText(
        `$logPath,
        `$Text + [Environment]::NewLine,
        `$encoding
    )
}

try {
    Write-PipelineLog -Text "Starting compiled LeanSERP normalization."

    `$inputs = @(
        Get-Content -LiteralPath '$inputListLiteral' |
            Where-Object {
                -not [string]::IsNullOrWhiteSpace(`$_)
            }
    )

    if (`$inputs.Count -eq 0) {
        throw "The input-list file contains no source files."
    }

    `$normalizerArguments = [System.Collections.Generic.List[string]]::new()

    foreach (`$inputPath in `$inputs) {
        [void]`$normalizerArguments.Add("--input")
        [void]`$normalizerArguments.Add(`$inputPath)
    }

    [void]`$normalizerArguments.Add("--output")
    [void]`$normalizerArguments.Add('$compiledOutputLiteral')
    [void]`$normalizerArguments.Add("--psl")
    [void]`$normalizerArguments.Add('$pslLiteral')
    [void]`$normalizerArguments.Add("--chunk-size")
    [void]`$normalizerArguments.Add('$chunkSize')

    if ($keepUnderscoresLiteral) {
        [void]`$normalizerArguments.Add("--keep-underscores")
    }

    if ($removeWwwLiteral) {
        [void]`$normalizerArguments.Add("--remove-www")
    }

    & '$normalizerLiteral' @normalizerArguments 2>&1 |
        ForEach-Object {
            `$line = [string]`$_
            Write-PipelineLog -Text `$line
        }

    if (`$LASTEXITCODE -ne 0) {
        throw "Compiled normalizer failed with exit code `$LASTEXITCODE."
    }

    `$compiledBuild = @(
        Get-ChildItem -LiteralPath '$compiledOutputLiteral' -Directory |
            Where-Object {
                `$_.Name -like "compiled-build-*"
            } |
            Sort-Object LastWriteTime -Descending
    ) | Select-Object -First 1

    if (`$null -eq `$compiledBuild) {
        throw "No compiled build directory was produced."
    }

    `$compiledMetadataPath = Join-Path `$compiledBuild.FullName "metadata.json"

    if (-not (Test-Path -LiteralPath `$compiledMetadataPath -PathType Leaf)) {
        throw "The compiled build has no metadata.json."
    }

    Write-PipelineLog -Text ""
    Write-PipelineLog -Text "Applying approved rules."

    `$postprocessorArguments = @(
        "--input-build"
        `$compiledBuild.FullName
        "--approved-rules"
        '$approvedRulesLiteral'
        "--output"
        '$approvedOutputLiteral'
    )

    & '$postprocessorLiteral' @postprocessorArguments 2>&1 |
        ForEach-Object {
            `$line = [string]`$_
            Write-PipelineLog -Text `$line
        }

    if (`$LASTEXITCODE -ne 0) {
        throw "Approved-rule postprocessor failed with exit code `$LASTEXITCODE."
    }

    `$approvedBuild = @(
        Get-ChildItem -LiteralPath '$approvedOutputLiteral' -Directory |
            Where-Object {
                `$_.Name -like "approved-build-*"
            } |
            Sort-Object LastWriteTime -Descending
    ) | Select-Object -First 1

    if (`$null -eq `$approvedBuild) {
        throw "No approved build directory was produced."
    }

    `$approvedReportPath = Join-Path `$approvedBuild.FullName "approved-overrides-report.json"

    if (-not (Test-Path -LiteralPath `$approvedReportPath -PathType Leaf)) {
        throw "The approved build has no approved-overrides-report.json."
    }

    Write-PipelineLog -Text ""
    Write-PipelineLog -Text "Creating unified LeanSERP package."

    `$packageArguments = @(
        "-NoProfile"
        "-ExecutionPolicy"
        "Bypass"
        "-File"
        '$packageGeneratorLiteral'
        "-ApprovedBuild"
        `$approvedBuild.FullName
        "-HostSubdomainBlocks"
        '$hostSubdomainsLiteral'
        "-OutputDirectory"
        '$packageOutputLiteral'
    )

    & "powershell.exe" @packageArguments 2>&1 |
        ForEach-Object {
            `$line = [string]`$_
            Write-PipelineLog -Text `$line
        }

    if (`$LASTEXITCODE -ne 0) {
        throw "Unified package generation failed with exit code `$LASTEXITCODE."
    }

    `$package = @(
        Get-ChildItem -LiteralPath '$packageOutputLiteral' -Directory |
            Where-Object {
                `$_.Name -like "LeanSERP-Package-*"
            } |
            Sort-Object LastWriteTime -Descending
    ) | Select-Object -First 1

    if (`$null -eq `$package) {
        throw "No unified LeanSERP package was produced."
    }

    `$manifestPath = Join-Path `$package.FullName "metadata.json"

    if (-not (Test-Path -LiteralPath `$manifestPath -PathType Leaf)) {
        throw "The unified package has no metadata.json."
    }

    `$result = [ordered]@{
        compiledBuild = `$compiledBuild.FullName
        approvedBuild = `$approvedBuild.FullName
        package = `$package.FullName
        completedAt = [DateTimeOffset]::UtcNow.ToString("o")
    }

    `$resultPath = '$logLiteral' + ".result.json"

    [System.IO.File]::WriteAllText(
        `$resultPath,
        (`$result | ConvertTo-Json -Depth 5) + [Environment]::NewLine,
        `$encoding
    )

    Write-PipelineLog -Text ""
    Write-PipelineLog -Text "Compiled LeanSERP pipeline completed."
    Write-PipelineLog -Text ("Compiled build: " + `$compiledBuild.FullName)
    Write-PipelineLog -Text ("Approved build: " + `$approvedBuild.FullName)
    Write-PipelineLog -Text ("Unified package: " + `$package.FullName)
    exit 0
}
catch {
    Write-PipelineLog -Text ""
    Write-PipelineLog -Text "PIPELINE ERROR"
    Write-PipelineLog -Text (`$_ | Out-String)
    exit 1
}
"@

    [System.IO.File]::WriteAllText(
        $pipelineScript,
        $pipelineCode,
        [System.Text.UTF8Encoding]::new($false)
    )

    $arguments = @(
        "-NoProfile"
        "-ExecutionPolicy"
        "Bypass"
        "-File"
        $pipelineScript
    )

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = "powershell.exe"

    $quotedArguments = @(
        foreach ($argument in $arguments) {
            Quote-NativeArgument -Value $argument
        }
    )

    $startInfo.Arguments = $quotedArguments -join " "
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo

    try {
        [void]$process.Start()
    }
    catch {
        $process.Dispose()
        Set-InterfaceRunning -Running $false

        [void][System.Windows.Forms.MessageBox]::Show(
            "Could not start the compiled pipeline:`r`n$($_.Exception.Message)",
            "LeanSERP Studio",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error
        )

        return
    }

    $script:activeProcess = $process
    $script:activeStage = "Compiled pipeline"
    $statusTextBox.Text = "Compiled pipeline running..."
    $timer.Start()
}

function Read-PipelineResult {
    $resultPath = $script:activeLogPath + ".result.json"

    if (-not (Test-Path -LiteralPath $resultPath -PathType Leaf)) {
        return $false
    }

    try {
        $result = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json

        $compiledProperty = $result.PSObject.Properties["compiledBuild"]
        $approvedProperty = $result.PSObject.Properties["approvedBuild"]
        $packageProperty = $result.PSObject.Properties["package"]

        if ($null -ne $compiledProperty) {
            $script:compiledBuildPath = [string]$compiledProperty.Value
        }

        if ($null -ne $approvedProperty) {
            $script:approvedBuildPath = [string]$approvedProperty.Value
        }

        if ($null -ne $packageProperty) {
            $script:packagePath = [string]$packageProperty.Value
        }

        return -not [string]::IsNullOrWhiteSpace($script:packagePath)
    }
    catch {
        return $false
    }
}

function Test-UnifiedPackage {
    param(
        [Parameter(Mandatory = $true)]
        [string]$PackagePath
    )

    if (-not (Test-Path -LiteralPath $PackagePath -PathType Container)) {
        throw "Package directory not found: $PackagePath"
    }

    $manifestPath = Join-Path $PackagePath "metadata.json"

    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "Package metadata.json is missing."
    }

    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $filesProperty = $manifest.PSObject.Properties["files"]

    if ($null -eq $filesProperty -or $null -eq $filesProperty.Value) {
        throw "Package manifest contains no files object."
    }

    $verifiedCount = 0

    foreach ($property in $filesProperty.Value.PSObject.Properties) {
        $name = $property.Name
        $record = $property.Value
        $filePath = Join-Path $PackagePath $name

        if (-not (Test-Path -LiteralPath $filePath -PathType Leaf)) {
            throw "Package file is missing: $name"
        }

        $hashProperty = $record.PSObject.Properties["sha256"]
        $lengthProperty = $record.PSObject.Properties["byteLength"]
        $countProperty = $record.PSObject.Properties["count"]

        if ($null -eq $hashProperty) {
            throw "Manifest hash is missing for $name."
        }

        if ($null -eq $lengthProperty) {
            throw "Manifest byte length is missing for $name."
        }

        if ($null -eq $countProperty) {
            throw "Manifest count is missing for $name."
        }

        $actualHash = (
            Get-FileHash -LiteralPath $filePath -Algorithm SHA256
        ).Hash.ToLowerInvariant()

        $expectedHash = ([string]$hashProperty.Value).ToLowerInvariant()

        if ($actualHash -ne $expectedHash) {
            throw "SHA-256 verification failed: $name"
        }

        $actualLength = (Get-Item -LiteralPath $filePath).Length
        $expectedLength = [long]$lengthProperty.Value

        if ($actualLength -ne $expectedLength) {
            throw "Byte-length verification failed: $name"
        }

        $actualCount = Get-LineCount -Path $filePath
        $expectedCount = [long]$countProperty.Value

        if ($actualCount -ne $expectedCount) {
            throw "Line-count verification failed: $name"
        }

        $verifiedCount++
    }

    return [pscustomobject]@{
        Package = $PackagePath
        FilesVerified = $verifiedCount
        Manifest = $manifestPath
        Verified = $true
    }
}

function Get-SelectedFileText {
    $paths = if ($fileList.SelectedItems.Count -gt 0) {
        @(
            $fileList.SelectedItems |
                ForEach-Object {
                    [string]$_
                }
        )
    }
    else {
        @(
            $selectedFiles |
                ForEach-Object {
                    [string]$_
                }
        )
    }

    return ($paths -join [Environment]::NewLine)
}

function Get-InterfaceReport {
    $lines = [System.Collections.Generic.List[string]]::new()

    [void]$lines.Add("LeanSERP compiled Studio interface report")
    [void]$lines.Add("Created: " + (Get-Date).ToString("yyyy-MM-dd HH:mm:ss"))
    [void]$lines.Add("")
    [void]$lines.Add("Window")
    [void]$lines.Add("Title: " + $form.Text)
    [void]$lines.Add(
        "Client size: " +
        $form.ClientSize.Width +
        "x" +
        $form.ClientSize.Height
    )
    [void]$lines.Add("Status: " + $statusTextBox.Text)
    [void]$lines.Add("Stage: " + $script:activeStage)
    [void]$lines.Add("Build running: " + [string](Test-ProcessRunning))
    [void]$lines.Add("")
    [void]$lines.Add("Source files")
    [void]$lines.Add("Selected count: " + $selectedFiles.Count)

    if ($selectedFiles.Count -eq 0) {
        [void]$lines.Add("(none)")
    }
    else {
        foreach ($path in $selectedFiles) {
            [void]$lines.Add([string]$path)
        }
    }

    [void]$lines.Add("")
    [void]$lines.Add("Options")
    [void]$lines.Add("Compiled output: " + $compiledOutputTextBox.Text)
    [void]$lines.Add("Approved output: " + $approvedOutputTextBox.Text)
    [void]$lines.Add("Package output: " + $packageOutputTextBox.Text)
    [void]$lines.Add("Chunk size: " + [string][int]$chunkNumeric.Value)
    [void]$lines.Add(
        "Keep underscores: " +
        [string]$keepUnderscoresCheckBox.Checked
    )
    [void]$lines.Add(
        "Remove www-number labels: " +
        [string]$removeWwwCheckBox.Checked
    )

    [void]$lines.Add("")
    [void]$lines.Add("Controls")

    $controls = @(
        [pscustomobject]@{
            Name = "Add files"
            Control = $addFilesButton
        }
        [pscustomobject]@{
            Name = "Remove selected"
            Control = $removeFilesButton
        }
        [pscustomobject]@{
            Name = "Clear list"
            Control = $clearFilesButton
        }
        [pscustomobject]@{
            Name = "Copy selected files"
            Control = $copyFilesButton
        }
        [pscustomobject]@{
            Name = "Build package"
            Control = $buildButton
        }
        [pscustomobject]@{
            Name = "Stop"
            Control = $stopButton
        }
        [pscustomobject]@{
            Name = "Verify package"
            Control = $verifyPackageButton
        }
        [pscustomobject]@{
            Name = "Open package"
            Control = $openPackageButton
        }
        [pscustomobject]@{
            Name = "Open PSL review"
            Control = $openReviewButton
        }
        [pscustomobject]@{
            Name = "Copy status"
            Control = $copyStatusButton
        }
        [pscustomobject]@{
            Name = "Copy log"
            Control = $copyLogButton
        }
        [pscustomobject]@{
            Name = "Copy full report"
            Control = $copyReportButton
        }
        [pscustomobject]@{
            Name = "Copy interface report"
            Control = $copyInterfaceButton
        }
    )

    foreach ($entry in $controls) {
        $control = $entry.Control

        [void]$lines.Add(
            $entry.Name +
            ": enabled=" +
            [string]$control.Enabled +
            ", visible=" +
            [string]$control.Visible +
            ", location=" +
            $control.Left +
            "," +
            $control.Top +
            ", size=" +
            $control.Width +
            "x" +
            $control.Height
        )
    }

    [void]$lines.Add("")
    [void]$lines.Add("Layout")
    [void]$lines.Add(
        "Source panel auto-scroll: " +
        [string]$sourceButtons.AutoScroll
    )
    [void]$lines.Add(
        "Source panel display rectangle: " +
        $sourceButtons.DisplayRectangle.Width +
        "x" +
        $sourceButtons.DisplayRectangle.Height
    )
    [void]$lines.Add("Progress style: " + $progressBar.Style)
    [void]$lines.Add("Progress value: " + $progressBar.Value)
    [void]$lines.Add("Visible log characters: " + $logTextBox.TextLength)
    [void]$lines.Add("Current log: " + $script:activeLogPath)
    [void]$lines.Add("Compiled build: " + $script:compiledBuildPath)
    [void]$lines.Add("Approved build: " + $script:approvedBuildPath)
    [void]$lines.Add("Unified package: " + $script:packagePath)

    return ($lines -join [Environment]::NewLine)
}

function Get-FullReport {
    $lines = [System.Collections.Generic.List[string]]::new()

    [void]$lines.Add("LeanSERP compiled Studio report")
    [void]$lines.Add("Created: " + (Get-Date).ToString("yyyy-MM-dd HH:mm:ss"))
    [void]$lines.Add("")
    [void]$lines.Add("Status: " + $statusTextBox.Text)
    [void]$lines.Add("Stage: " + $script:activeStage)
    [void]$lines.Add("Build running: " + [string](Test-ProcessRunning))
    [void]$lines.Add("Selected files: " + $selectedFiles.Count)

    foreach ($path in $selectedFiles) {
        [void]$lines.Add("  " + [string]$path)
    }

    [void]$lines.Add("")
    [void]$lines.Add("Compiled output: " + $compiledOutputTextBox.Text)
    [void]$lines.Add("Approved output: " + $approvedOutputTextBox.Text)
    [void]$lines.Add("Package output: " + $packageOutputTextBox.Text)
    [void]$lines.Add("Chunk size: " + [string][int]$chunkNumeric.Value)
    [void]$lines.Add("Keep underscores: " + [string]$keepUnderscoresCheckBox.Checked)
    [void]$lines.Add("Remove www-number labels: " + [string]$removeWwwCheckBox.Checked)
    [void]$lines.Add("Compiled build: " + $script:compiledBuildPath)
    [void]$lines.Add("Approved build: " + $script:approvedBuildPath)
    [void]$lines.Add("Unified package: " + $script:packagePath)
    [void]$lines.Add("Current log: " + $script:activeLogPath)
    [void]$lines.Add("")
    [void]$lines.Add("Log:")
    [void]$lines.Add($logTextBox.Text)

    return ($lines -join [Environment]::NewLine)
}

$form = [System.Windows.Forms.Form]::new()
$form.Text = "LeanSERP Studio - Compiled Pipeline"
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$form.MinimumSize = [System.Drawing.Size]::new(940, 720)
$form.Size = [System.Drawing.Size]::new(1120, 860)
$form.Font = [System.Drawing.Font]::new("Segoe UI", 9)
$form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::Dpi

$root = [System.Windows.Forms.TableLayoutPanel]::new()
$root.Dock = [System.Windows.Forms.DockStyle]::Fill
$root.Padding = [System.Windows.Forms.Padding]::new(14)
$root.ColumnCount = 1
$root.RowCount = 5

[void]$root.ColumnStyles.Add(
    [System.Windows.Forms.ColumnStyle]::new(
        [System.Windows.Forms.SizeType]::Percent,
        100
    )
)

[void]$root.RowStyles.Add(
    [System.Windows.Forms.RowStyle]::new(
        [System.Windows.Forms.SizeType]::AutoSize
    )
)

[void]$root.RowStyles.Add(
    [System.Windows.Forms.RowStyle]::new(
        [System.Windows.Forms.SizeType]::Percent,
        36
    )
)

[void]$root.RowStyles.Add(
    [System.Windows.Forms.RowStyle]::new(
        [System.Windows.Forms.SizeType]::AutoSize
    )
)

[void]$root.RowStyles.Add(
    [System.Windows.Forms.RowStyle]::new(
        [System.Windows.Forms.SizeType]::AutoSize
    )
)

[void]$root.RowStyles.Add(
    [System.Windows.Forms.RowStyle]::new(
        [System.Windows.Forms.SizeType]::Percent,
        64
    )
)

$titlePanel = [System.Windows.Forms.FlowLayoutPanel]::new()
$titlePanel.Dock = [System.Windows.Forms.DockStyle]::Fill
$titlePanel.AutoSize = $true
$titlePanel.FlowDirection = [System.Windows.Forms.FlowDirection]::TopDown
$titlePanel.WrapContents = $false
$titlePanel.Margin = [System.Windows.Forms.Padding]::new(0, 0, 0, 10)

$titleLabel = [System.Windows.Forms.Label]::new()
$titleLabel.Text = "LeanSERP Studio"
$titleLabel.Font = [System.Drawing.Font]::new(
    "Segoe UI",
    18,
    [System.Drawing.FontStyle]::Bold
)
$titleLabel.AutoSize = $true

$descriptionLabel = [System.Windows.Forms.Label]::new()
$descriptionLabel.Text = "Compiled URL normalization, approved rules, and unified package generation."
$descriptionLabel.AutoSize = $true

[void]$titlePanel.Controls.Add($titleLabel)
[void]$titlePanel.Controls.Add($descriptionLabel)

$sourceGroup = [System.Windows.Forms.GroupBox]::new()
$sourceGroup.Text = "1. Source files"
$sourceGroup.Dock = [System.Windows.Forms.DockStyle]::Fill
$sourceGroup.Margin = [System.Windows.Forms.Padding]::new(0, 0, 0, 10)

$sourceLayout = [System.Windows.Forms.TableLayoutPanel]::new()
$sourceLayout.Dock = [System.Windows.Forms.DockStyle]::Fill
$sourceLayout.Padding = [System.Windows.Forms.Padding]::new(10)
$sourceLayout.ColumnCount = 2
$sourceLayout.RowCount = 1

[void]$sourceLayout.ColumnStyles.Add(
    [System.Windows.Forms.ColumnStyle]::new(
        [System.Windows.Forms.SizeType]::Percent,
        100
    )
)

[void]$sourceLayout.ColumnStyles.Add(
    [System.Windows.Forms.ColumnStyle]::new(
        [System.Windows.Forms.SizeType]::Absolute,
        185
    )
)

$fileList = [System.Windows.Forms.ListBox]::new()
$fileList.Dock = [System.Windows.Forms.DockStyle]::Fill
$fileList.HorizontalScrollbar = $true
$fileList.SelectionMode = [System.Windows.Forms.SelectionMode]::MultiExtended
$fileList.Margin = [System.Windows.Forms.Padding]::new(0, 0, 10, 0)

$sourceButtons = [System.Windows.Forms.FlowLayoutPanel]::new()
$sourceButtons.Dock = [System.Windows.Forms.DockStyle]::Fill
$sourceButtons.FlowDirection = [System.Windows.Forms.FlowDirection]::TopDown
$sourceButtons.WrapContents = $false
$sourceButtons.AutoScroll = $true
$sourceButtons.AutoSize = $false

$addFilesButton = New-Button -Text "Add files..." -Width 160
$removeFilesButton = New-Button -Text "Remove selected" -Width 160
$clearFilesButton = New-Button -Text "Clear list" -Width 160
$copyFilesButton = New-Button -Text "Copy selected files" -Width 160

$fileCountTextBox = [System.Windows.Forms.TextBox]::new()
$fileCountTextBox.ReadOnly = $true
$fileCountTextBox.BorderStyle = [System.Windows.Forms.BorderStyle]::None
$fileCountTextBox.Width = 160
$fileCountTextBox.Text = "0 files selected"

foreach ($control in @(
    $addFilesButton
    $removeFilesButton
    $clearFilesButton
    $copyFilesButton
    $fileCountTextBox
)) {
    [void]$sourceButtons.Controls.Add($control)
}

[void]$sourceLayout.Controls.Add($fileList, 0, 0)
[void]$sourceLayout.Controls.Add($sourceButtons, 1, 0)
[void]$sourceGroup.Controls.Add($sourceLayout)

$optionsGroup = [System.Windows.Forms.GroupBox]::new()
$optionsGroup.Text = "2. Output and options"
$optionsGroup.Dock = [System.Windows.Forms.DockStyle]::Fill
$optionsGroup.AutoSize = $true
$optionsGroup.Margin = [System.Windows.Forms.Padding]::new(0, 0, 0, 10)

$optionsLayout = [System.Windows.Forms.TableLayoutPanel]::new()
$optionsLayout.Dock = [System.Windows.Forms.DockStyle]::Fill
$optionsLayout.AutoSize = $true
$optionsLayout.Padding = [System.Windows.Forms.Padding]::new(10)
$optionsLayout.ColumnCount = 3
$optionsLayout.RowCount = 5

[void]$optionsLayout.ColumnStyles.Add(
    [System.Windows.Forms.ColumnStyle]::new(
        [System.Windows.Forms.SizeType]::AutoSize
    )
)

[void]$optionsLayout.ColumnStyles.Add(
    [System.Windows.Forms.ColumnStyle]::new(
        [System.Windows.Forms.SizeType]::Percent,
        100
    )
)

[void]$optionsLayout.ColumnStyles.Add(
    [System.Windows.Forms.ColumnStyle]::new(
        [System.Windows.Forms.SizeType]::AutoSize
    )
)

$compiledOutputLabel = [System.Windows.Forms.Label]::new()
$compiledOutputLabel.Text = "Compiled output:"
$compiledOutputLabel.AutoSize = $true

$compiledOutputTextBox = [System.Windows.Forms.TextBox]::new()
$compiledOutputTextBox.Text = $defaultCompiledOutput
$compiledOutputTextBox.Dock = [System.Windows.Forms.DockStyle]::Fill

$browseCompiledButton = New-Button -Text "Browse..." -Width 110

$approvedOutputLabel = [System.Windows.Forms.Label]::new()
$approvedOutputLabel.Text = "Approved output:"
$approvedOutputLabel.AutoSize = $true

$approvedOutputTextBox = [System.Windows.Forms.TextBox]::new()
$approvedOutputTextBox.Text = $defaultApprovedOutput
$approvedOutputTextBox.Dock = [System.Windows.Forms.DockStyle]::Fill

$browseApprovedButton = New-Button -Text "Browse..." -Width 110

$packageOutputLabel = [System.Windows.Forms.Label]::new()
$packageOutputLabel.Text = "Package output:"
$packageOutputLabel.AutoSize = $true

$packageOutputTextBox = [System.Windows.Forms.TextBox]::new()
$packageOutputTextBox.Text = $defaultPackageOutput
$packageOutputTextBox.Dock = [System.Windows.Forms.DockStyle]::Fill

$browsePackageButton = New-Button -Text "Browse..." -Width 110

$chunkLabel = [System.Windows.Forms.Label]::new()
$chunkLabel.Text = "Labels per chunk:"
$chunkLabel.AutoSize = $true

$chunkNumeric = [System.Windows.Forms.NumericUpDown]::new()
$chunkNumeric.Minimum = 1000
$chunkNumeric.Maximum = 1000000
$chunkNumeric.Increment = 50000
$chunkNumeric.Value = 500000
$chunkNumeric.ThousandsSeparator = $true
$chunkNumeric.Width = 150

$optionPanel = [System.Windows.Forms.FlowLayoutPanel]::new()
$optionPanel.AutoSize = $true
$optionPanel.Dock = [System.Windows.Forms.DockStyle]::Fill
$optionPanel.FlowDirection = [System.Windows.Forms.FlowDirection]::LeftToRight
$optionPanel.WrapContents = $true

$keepUnderscoresCheckBox = [System.Windows.Forms.CheckBox]::new()
$keepUnderscoresCheckBox.Text = "Keep underscores"
$keepUnderscoresCheckBox.Checked = $true
$keepUnderscoresCheckBox.AutoSize = $true
$keepUnderscoresCheckBox.Margin = [System.Windows.Forms.Padding]::new(0, 5, 20, 5)

$removeWwwCheckBox = [System.Windows.Forms.CheckBox]::new()
$removeWwwCheckBox.Text = "Remove leading www and www<number> labels"
$removeWwwCheckBox.Checked = $true
$removeWwwCheckBox.AutoSize = $true
$removeWwwCheckBox.Margin = [System.Windows.Forms.Padding]::new(0, 5, 0, 5)

[void]$optionPanel.Controls.Add($keepUnderscoresCheckBox)
[void]$optionPanel.Controls.Add($removeWwwCheckBox)

[void]$optionsLayout.Controls.Add($compiledOutputLabel, 0, 0)
[void]$optionsLayout.Controls.Add($compiledOutputTextBox, 1, 0)
[void]$optionsLayout.Controls.Add($browseCompiledButton, 2, 0)

[void]$optionsLayout.Controls.Add($approvedOutputLabel, 0, 1)
[void]$optionsLayout.Controls.Add($approvedOutputTextBox, 1, 1)
[void]$optionsLayout.Controls.Add($browseApprovedButton, 2, 1)

[void]$optionsLayout.Controls.Add($packageOutputLabel, 0, 2)
[void]$optionsLayout.Controls.Add($packageOutputTextBox, 1, 2)
[void]$optionsLayout.Controls.Add($browsePackageButton, 2, 2)

[void]$optionsLayout.Controls.Add($chunkLabel, 0, 3)
[void]$optionsLayout.Controls.Add($chunkNumeric, 1, 3)
[void]$optionsLayout.Controls.Add($optionPanel, 1, 4)
$optionsLayout.SetColumnSpan($optionPanel, 2)

[void]$optionsGroup.Controls.Add($optionsLayout)

$actionGroup = [System.Windows.Forms.GroupBox]::new()
$actionGroup.Text = "3. Build and verify"
$actionGroup.Dock = [System.Windows.Forms.DockStyle]::Fill
$actionGroup.AutoSize = $true
$actionGroup.Margin = [System.Windows.Forms.Padding]::new(0, 0, 0, 10)

$actionLayout = [System.Windows.Forms.TableLayoutPanel]::new()
$actionLayout.Dock = [System.Windows.Forms.DockStyle]::Fill
$actionLayout.AutoSize = $true
$actionLayout.Padding = [System.Windows.Forms.Padding]::new(10)
$actionLayout.ColumnCount = 1
$actionLayout.RowCount = 3

$actionButtons = [System.Windows.Forms.FlowLayoutPanel]::new()
$actionButtons.Dock = [System.Windows.Forms.DockStyle]::Fill
$actionButtons.AutoSize = $true
$actionButtons.FlowDirection = [System.Windows.Forms.FlowDirection]::LeftToRight
$actionButtons.WrapContents = $true

$buildButton = New-Button -Text "Build package" -Width 140
$stopButton = New-Button -Text "Stop" -Width 90
$stopButton.Enabled = $false
$verifyPackageButton = New-Button -Text "Verify package" -Width 135
$openPackageButton = New-Button -Text "Open package" -Width 125
$openReviewButton = New-Button -Text "Open PSL review" -Width 135
$copyStatusButton = New-Button -Text "Copy status" -Width 115
$copyLogButton = New-Button -Text "Copy log" -Width 105
$copyLogButton.Enabled = $false
$copyReportButton = New-Button -Text "Copy full report" -Width 145
$copyInterfaceButton = New-Button -Text "Copy interface report" -Width 165

foreach ($control in @(
    $buildButton
    $stopButton
    $verifyPackageButton
    $openPackageButton
    $openReviewButton
    $copyStatusButton
    $copyLogButton
    $copyReportButton
    $copyInterfaceButton
)) {
    [void]$actionButtons.Controls.Add($control)
}

$statusTextBox = [System.Windows.Forms.TextBox]::new()
$statusTextBox.Text = "Ready."
$statusTextBox.ReadOnly = $true
$statusTextBox.Dock = [System.Windows.Forms.DockStyle]::Fill
$statusTextBox.Margin = [System.Windows.Forms.Padding]::new(0, 2, 0, 7)

$progressBar = [System.Windows.Forms.ProgressBar]::new()
$progressBar.Dock = [System.Windows.Forms.DockStyle]::Fill
$progressBar.Style = [System.Windows.Forms.ProgressBarStyle]::Continuous
$progressBar.Minimum = 0
$progressBar.Maximum = 100
$progressBar.Value = 0

[void]$actionLayout.Controls.Add($actionButtons, 0, 0)
[void]$actionLayout.Controls.Add($statusTextBox, 0, 1)
[void]$actionLayout.Controls.Add($progressBar, 0, 2)
[void]$actionGroup.Controls.Add($actionLayout)

$logGroup = [System.Windows.Forms.GroupBox]::new()
$logGroup.Text = "Pipeline log"
$logGroup.Dock = [System.Windows.Forms.DockStyle]::Fill
$logGroup.Margin = [System.Windows.Forms.Padding]::new(0)

$logTextBox = [System.Windows.Forms.TextBox]::new()
$logTextBox.Dock = [System.Windows.Forms.DockStyle]::Fill
$logTextBox.Multiline = $true
$logTextBox.ReadOnly = $true
$logTextBox.ScrollBars = [System.Windows.Forms.ScrollBars]::Both
$logTextBox.WordWrap = $false
$logTextBox.Font = [System.Drawing.Font]::new("Consolas", 9)

[void]$logGroup.Controls.Add($logTextBox)

[void]$root.Controls.Add($titlePanel, 0, 0)
[void]$root.Controls.Add($sourceGroup, 0, 1)
[void]$root.Controls.Add($optionsGroup, 0, 2)
[void]$root.Controls.Add($actionGroup, 0, 3)
[void]$root.Controls.Add($logGroup, 0, 4)
[void]$form.Controls.Add($root)

function Select-OutputDirectory {
    param(
        [Parameter(Mandatory = $true)]
        [System.Windows.Forms.TextBox]$Target
    )

    $dialog = [System.Windows.Forms.FolderBrowserDialog]::new()
    $dialog.Description = "Select an output directory"

    if (
        -not [string]::IsNullOrWhiteSpace($Target.Text) -and
        (Test-Path -LiteralPath $Target.Text -PathType Container)
    ) {
        $dialog.SelectedPath = $Target.Text
    }

    try {
        if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
            $Target.Text = $dialog.SelectedPath
        }
    }
    finally {
        $dialog.Dispose()
    }
}

$timer = [System.Windows.Forms.Timer]::new()
$timer.Interval = 500

$timer.Add_Tick({
    try {
        Refresh-Log

        if (
            $null -ne $script:activeProcess -and
            $script:activeProcess.HasExited
        ) {
            $exitCode = $script:activeProcess.ExitCode

            try {
                $script:activeProcess.WaitForExit()
            }
            catch {
            }

            Refresh-Log
            $script:activeProcess.Dispose()
            $script:activeProcess = $null
            $timer.Stop()

            if (
                -not [string]::IsNullOrWhiteSpace($script:activeInputListPath) -and
                (Test-Path -LiteralPath $script:activeInputListPath -PathType Leaf)
            ) {
                Remove-Item -LiteralPath $script:activeInputListPath -Force -ErrorAction SilentlyContinue
            }

            $script:activeInputListPath = ""

            if ($script:stopRequested) {
                $statusTextBox.Text = "Pipeline stopped."
                $script:activeStage = "Stopped"
            }
            elseif ($exitCode -eq 0 -and (Read-PipelineResult)) {
                $statusTextBox.Text = "Pipeline completed and package created."
                $script:activeStage = "Completed"

                try {
                    $verification = Test-UnifiedPackage -PackagePath $script:packagePath
                    $statusTextBox.Text = "Pipeline completed. Package verification passed."
                    [System.IO.File]::AppendAllText(
                        $script:activeLogPath,
                        (
                            [Environment]::NewLine +
                            "Package verification passed." +
                            [Environment]::NewLine +
                            "Files verified: " +
                            $verification.FilesVerified +
                            [Environment]::NewLine
                        ),
                        [System.Text.UTF8Encoding]::new($false)
                    )
                    Refresh-Log
                }
                catch {
                    $statusTextBox.Text = "Pipeline completed, but package verification failed."
                    [void][System.Windows.Forms.MessageBox]::Show(
                        "The package was created, but verification failed:`r`n$($_.Exception.Message)",
                        "LeanSERP Studio",
                        [System.Windows.Forms.MessageBoxButtons]::OK,
                        [System.Windows.Forms.MessageBoxIcon]::Error
                    )
                }
            }
            else {
                $statusTextBox.Text = "Pipeline failed. Exit code: $exitCode"
                $script:activeStage = "Failed"
            }

            Set-InterfaceRunning -Running $false
        }
    }
    catch {
        $timer.Stop()
        $statusTextBox.Text = "GUI timer error: $($_.Exception.Message)"
        $script:activeStage = "Timer error"
        Set-InterfaceRunning -Running $false

        [void][System.Windows.Forms.MessageBox]::Show(
            "A GUI timer operation failed:`r`n$($_.Exception.Message)",
            "LeanSERP Studio",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error
        )
    }
})

$addFilesButton.Add_Click({
    $dialog = [System.Windows.Forms.OpenFileDialog]::new()
    $dialog.Title = "Select URL or hostname source files"
    $dialog.Filter = "Text and list files|*.txt;*.list;*.dat|All files|*.*"
    $dialog.Multiselect = $true
    $dialog.CheckFileExists = $true

    try {
        if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
            foreach ($path in $dialog.FileNames) {
                if (-not $selectedFiles.Contains($path)) {
                    [void]$selectedFiles.Add($path)
                }
            }

            Update-FileList
        }
    }
    finally {
        $dialog.Dispose()
    }
})

$removeFilesButton.Add_Click({
    $paths = @(
        $fileList.SelectedItems |
            ForEach-Object {
                [string]$_
            }
    )

    foreach ($path in $paths) {
        [void]$selectedFiles.Remove($path)
    }

    Update-FileList
})

$clearFilesButton.Add_Click({
    $selectedFiles.Clear()
    Update-FileList
})

$copyFilesButton.Add_Click({
    Set-ClipboardText -Text (Get-SelectedFileText) -Description "selected file paths"
})

$browseCompiledButton.Add_Click({
    Select-OutputDirectory -Target $compiledOutputTextBox
})

$browseApprovedButton.Add_Click({
    Select-OutputDirectory -Target $approvedOutputTextBox
})

$browsePackageButton.Add_Click({
    Select-OutputDirectory -Target $packageOutputTextBox
})

$buildButton.Add_Click({
    try {
        Start-CompiledPipeline
    }
    catch {
        Set-InterfaceRunning -Running $false
        $statusTextBox.Text = "Could not start pipeline."
        $script:activeStage = "Start error"

        [void][System.Windows.Forms.MessageBox]::Show(
            "Could not start the compiled pipeline:`r`n$($_.Exception.Message)",
            "LeanSERP Studio",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error
        )
    }
})

$stopButton.Add_Click({
    if (-not (Test-ProcessRunning)) {
        return
    }

    $choice = [System.Windows.Forms.MessageBox]::Show(
        "Stop the compiled pipeline? An incomplete build directory may remain.",
        "LeanSERP Studio",
        [System.Windows.Forms.MessageBoxButtons]::YesNo,
        [System.Windows.Forms.MessageBoxIcon]::Warning
    )

    if ($choice -ne [System.Windows.Forms.DialogResult]::Yes) {
        return
    }

    $script:stopRequested = $true
    $statusTextBox.Text = "Stopping pipeline..."
    $script:activeStage = "Stopping"
    $stopButton.Enabled = $false

    try {
        Stop-ProcessTree -ProcessId $script:activeProcess.Id
    }
    catch {
        [void][System.Windows.Forms.MessageBox]::Show(
            "Could not stop the pipeline process tree:`r`n$($_.Exception.Message)",
            "LeanSERP Studio",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error
        )
    }
})

$verifyPackageButton.Add_Click({
    $packagePath = $script:packagePath

    if (
        [string]::IsNullOrWhiteSpace($packagePath) -or
        -not (Test-Path -LiteralPath $packagePath -PathType Container)
    ) {
        $dialog = [System.Windows.Forms.FolderBrowserDialog]::new()
        $dialog.Description = "Select a LeanSERP package directory"

        try {
            if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
                return
            }

            $packagePath = $dialog.SelectedPath
        }
        finally {
            $dialog.Dispose()
        }
    }

    try {
        $verification = Test-UnifiedPackage -PackagePath $packagePath
        $script:packagePath = $packagePath
        $statusTextBox.Text = "Package verification passed."

        [void][System.Windows.Forms.MessageBox]::Show(
            (
                "Package verification passed.`r`n`r`n" +
                "Files verified: " +
                $verification.FilesVerified +
                "`r`nPackage: " +
                $verification.Package
            ),
            "LeanSERP Studio",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Information
        )
    }
    catch {
        $statusTextBox.Text = "Package verification failed."

        [void][System.Windows.Forms.MessageBox]::Show(
            "Package verification failed:`r`n$($_.Exception.Message)",
            "LeanSERP Studio",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error
        )
    }
})

$openPackageButton.Add_Click({
    $path = $script:packagePath

    if (
        [string]::IsNullOrWhiteSpace($path) -or
        -not (Test-Path -LiteralPath $path -PathType Container)
    ) {
        $path = $packageOutputTextBox.Text.Trim()
    }

    if (-not (Test-Path -LiteralPath $path -PathType Container)) {
        [void](New-Item -ItemType Directory -Path $path -Force)
    }

    [void](Start-Process -FilePath "explorer.exe" -ArgumentList @($path))
})

$openReviewButton.Add_Click({
    $path = Join-Path $scriptDirectory "PSL-Host-Review"

    if (-not (Test-Path -LiteralPath $path -PathType Container)) {
        [void](New-Item -ItemType Directory -Path $path -Force)
    }

    [void](Start-Process -FilePath "explorer.exe" -ArgumentList @($path))
})

$copyStatusButton.Add_Click({
    Set-ClipboardText -Text $statusTextBox.Text -Description "status"
})

$copyLogButton.Add_Click({
    Set-ClipboardText -Text $logTextBox.Text -Description "log"
})

$copyReportButton.Add_Click({
    Set-ClipboardText -Text (Get-FullReport) -Description "full report"
})

$copyInterfaceButton.Add_Click({
    Set-ClipboardText `
        -Text (Get-InterfaceReport) `
        -Description "interface report"
})


$form.Add_FormClosing({
    param(
        [object]$Sender,
        [System.Windows.Forms.FormClosingEventArgs]$Event
    )

    if (-not (Test-ProcessRunning)) {
        return
    }

    $choice = [System.Windows.Forms.MessageBox]::Show(
        "The compiled pipeline is still running. Stop it and close Studio?",
        "LeanSERP Studio",
        [System.Windows.Forms.MessageBoxButtons]::YesNo,
        [System.Windows.Forms.MessageBoxIcon]::Warning
    )

    if ($choice -ne [System.Windows.Forms.DialogResult]::Yes) {
        $Event.Cancel = $true
        return
    }

    $script:stopRequested = $true

    try {
        Stop-ProcessTree -ProcessId $script:activeProcess.Id
    }
    catch {
    }
})

$form.Add_FormClosed({
    $timer.Stop()
    $timer.Dispose()

    if ($null -ne $script:activeProcess) {
        try {
            if (-not $script:activeProcess.HasExited) {
                Stop-ProcessTree -ProcessId $script:activeProcess.Id
            }
        }
        catch {
        }

        try {
            $script:activeProcess.Dispose()
        }
        catch {
        }

        $script:activeProcess = $null
    }

    if (
        -not [string]::IsNullOrWhiteSpace($script:activeInputListPath) -and
        (Test-Path -LiteralPath $script:activeInputListPath -PathType Leaf)
    ) {
        Remove-Item `
            -LiteralPath $script:activeInputListPath `
            -Force `
            -ErrorAction SilentlyContinue
    }

    $script:activeInputListPath = ""
})

Test-RequiredFiles
Update-FileList
Set-InterfaceRunning -Running $false

$null = $form.ShowDialog()
$form.Dispose()