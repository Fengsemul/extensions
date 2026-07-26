[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$scriptPath = $MyInvocation.MyCommand.Path
$scriptDirectory = Split-Path -Parent $scriptPath
$runnerPath = Join-Path $scriptDirectory "Invoke-LeanSERP-Build.ps1"
$builderPath = Join-Path $scriptDirectory "LeanSERP-Studio.ps1"
$defaultOutputDirectory = Join-Path $env:USERPROFILE "Downloads\LeanSERP-Output"

foreach ($requiredPath in @(
    $runnerPath,
    $builderPath
)) {
    if (
        -not (
            Test-Path `
                -LiteralPath $requiredPath `
                -PathType Leaf
        )
    ) {
        [void][System.Windows.Forms.MessageBox]::Show(
            "A required file was not found:`r`n$requiredPath",
            "LeanSERP Studio",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error
        )
        exit 1
    }
}

$selectedFiles =
    [System.Collections.Generic.List[string]]::new()

$script:activeProcess = $null
$script:activeLogPath = ""
$script:displayedLogLineCount = 0
$script:buildStartedAt = $null
$script:buildOutputDirectory = ""
$script:stopRequested = $false
$script:activeInputListPath = ""

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
    $button.Margin =
        [System.Windows.Forms.Padding]::new(
            0,
            0,
            9,
            9
        )

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
        [System.Windows.Forms.Clipboard]::SetText(
            $Text
        )
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

function Quote-ProcessArgument {
    param(
        [AllowEmptyString()]
        [string]$Value
    )

    if ($null -eq $Value) {
        return '""'
    }

    if (
        $Value.Length -gt 0 -and
        $Value -notmatch '[\s"]'
    ) {
        return $Value
    }

    $escaped =
        $Value -replace '(\\*)"', '$1$1\"'

    $escaped =
        $escaped -replace '(\\+)$', '$1$1'

    return '"' + $escaped + '"'
}

function Test-BuildRunning {
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

function Get-OtherStudioProcesses {
    $currentProcessId = $PID

    return @(
        Get-CimInstance `
            -ClassName Win32_Process `
            -Filter "Name = 'powershell.exe'" `
            -ErrorAction SilentlyContinue |
            Where-Object {
                $_.ProcessId -ne $currentProcessId -and
                $_.CommandLine -like
                    "*LeanSERP-Studio-GUI.ps1*"
            }
    )
}

function Close-OtherStudioProcesses {
    $closed = 0

    $failures =
        [System.Collections.Generic.List[string]]::new()

    foreach (
        $processInfo in
            (Get-OtherStudioProcesses)
    ) {
        try {
            Stop-Process `
                -Id $processInfo.ProcessId `
                -Force `
                -ErrorAction Stop

            $closed++
        }
        catch {
            [void]$failures.Add(
                "PID $($processInfo.ProcessId): $($_.Exception.Message)"
            )
        }
    }

    return [pscustomobject]@{
        Closed = $closed
        Failures = $failures.ToArray()
    }
}

function Stop-ProcessTree {
    param(
        [Parameter(Mandatory = $true)]
        [int]$ProcessId
    )

    $children = @(
        Get-CimInstance `
            -ClassName Win32_Process `
            -Filter "ParentProcessId = $ProcessId" `
            -ErrorAction SilentlyContinue
    )

    foreach ($child in $children) {
        Stop-ProcessTree `
            -ProcessId $child.ProcessId
    }

    try {
        Stop-Process `
            -Id $ProcessId `
            -Force `
            -ErrorAction Stop
    }
    catch {
    }
}

function Get-IncompleteBuildDirectories {
    param(
        [Parameter(Mandatory = $true)]
        [string]$OutputDirectory,

        [Parameter(Mandatory = $false)]
        [AllowNull()]
        [datetime]$StartedAt
    )

    if (
        -not (
            Test-Path `
                -LiteralPath $OutputDirectory `
                -PathType Container
        )
    ) {
        return @()
    }

    return @(
        Get-ChildItem `
            -LiteralPath $OutputDirectory `
            -Directory `
            -ErrorAction SilentlyContinue |
            Where-Object {
                if ($_.Name -notlike "build-*") {
                    return $false
                }

                if (
                    $null -ne $StartedAt -and
                    $_.CreationTime -lt
                        $StartedAt.AddSeconds(-5)
                ) {
                    return $false
                }

                $labelsPath =
                    Join-Path `
                        $_.FullName `
                        "serp-domain-labels.txt"

                $metadataPath =
                    Join-Path `
                        $_.FullName `
                        "serp-domain-labels.meta.json"

                return -not (
                    (
                        Test-Path `
                            -LiteralPath $labelsPath `
                            -PathType Leaf
                    ) -and
                    (
                        Test-Path `
                            -LiteralPath $metadataPath `
                            -PathType Leaf
                    )
                )
            }
    )
}

function Offer-IncompleteBuildCleanup {
    if (
        [string]::IsNullOrWhiteSpace(
            $script:buildOutputDirectory
        )
    ) {
        return
    }

    $directories = @(
        Get-IncompleteBuildDirectories `
            -OutputDirectory $script:buildOutputDirectory `
            -StartedAt $script:buildStartedAt
    )

    $directoryCount =
        [int]@($directories).Count

    if ($directoryCount -eq 0) {
        return
    }

    $noun = if (
        $directoryCount -eq 1
    ) {
        "directory"
    }
    else {
        "directories"
    }

    $message =
        "The interrupted build left " +
        $directoryCount +
        " incomplete build " +
        $noun +
        ".`r`n`r`nDelete " +
        $(if ($directoryCount -eq 1) {
            "it"
        } else {
            "them"
        }) +
        " now?"

    $choice =
        [System.Windows.Forms.MessageBox]::Show(
            $message,
            "LeanSERP Studio",
            [System.Windows.Forms.MessageBoxButtons]::YesNo,
            [System.Windows.Forms.MessageBoxIcon]::Question
        )

    if (
        $choice -ne
        [System.Windows.Forms.DialogResult]::Yes
    ) {
        return
    }

    $removed = 0
    $failures =
        [System.Collections.Generic.List[string]]::new()

    foreach (
        $directory in
        @($directories)
    ) {
        if ($null -eq $directory) {
            continue
        }

        try {
            $metadataPath =
                Join-Path `
                    $directory.FullName `
                    "serp-domain-labels.meta.json"

            if (
                Test-Path `
                    -LiteralPath $metadataPath `
                    -PathType Leaf
            ) {
                continue
            }

            Remove-Item `
                -LiteralPath $directory.FullName `
                -Recurse `
                -Force `
                -ErrorAction Stop

            $removed++
        }
        catch {
            [void]$failures.Add(
                $directory.FullName +
                ": " +
                $_.Exception.Message
            )
        }
    }

    $failureCount =
        [int]$failures.Count

    $resultNoun = if (
        $removed -eq 1
    ) {
        "directory"
    }
    else {
        "directories"
    }

    $resultText =
        "Removed " +
        $removed +
        " incomplete build " +
        $resultNoun +
        "."

    if ($failureCount -gt 0) {
        $resultText +=
            "`r`n`r`nFailures:`r`n" +
            ($failures.ToArray() -join "`r`n")
    }

    $icon = if (
        $failureCount -gt 0
    ) {
        [System.Windows.Forms.MessageBoxIcon]::Warning
    }
    else {
        [System.Windows.Forms.MessageBoxIcon]::Information
    }

    [void][System.Windows.Forms.MessageBox]::Show(
        $resultText,
        "LeanSERP Studio",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        $icon
    )
}

$form = [System.Windows.Forms.Form]::new()
$form.Text = "LeanSERP Studio"
$form.StartPosition =
    [System.Windows.Forms.FormStartPosition]::CenterScreen
$form.MinimumSize =
    [System.Drawing.Size]::new(
        900,
        700
    )
$form.Size =
    [System.Drawing.Size]::new(
        1050,
        820
    )
$form.Font =
    [System.Drawing.Font]::new(
        "Segoe UI",
        9
    )
$form.AutoScaleMode =
    [System.Windows.Forms.AutoScaleMode]::Dpi

$root =
    [System.Windows.Forms.TableLayoutPanel]::new()
$root.Dock =
    [System.Windows.Forms.DockStyle]::Fill
$root.Padding =
    [System.Windows.Forms.Padding]::new(
        14
    )
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
        45
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
        55
    )
)

$titlePanel =
    [System.Windows.Forms.FlowLayoutPanel]::new()
$titlePanel.Dock =
    [System.Windows.Forms.DockStyle]::Fill
$titlePanel.AutoSize = $true
$titlePanel.FlowDirection =
    [System.Windows.Forms.FlowDirection]::TopDown
$titlePanel.WrapContents = $false
$titlePanel.Margin =
    [System.Windows.Forms.Padding]::new(
        0,
        0,
        0,
        10
    )

$titleLabel =
    [System.Windows.Forms.Label]::new()
$titleLabel.Text = "LeanSERP Studio"
$titleLabel.Font =
    [System.Drawing.Font]::new(
        "Segoe UI",
        18,
        [System.Drawing.FontStyle]::Bold
    )
$titleLabel.AutoSize = $true

$descriptionLabel =
    [System.Windows.Forms.Label]::new()
$descriptionLabel.Text =
    "Build normalized, sorted, deduplicated label packages with bounded memory."
$descriptionLabel.AutoSize = $true

[void]$titlePanel.Controls.Add(
    $titleLabel
)
[void]$titlePanel.Controls.Add(
    $descriptionLabel
)

$sourceGroup =
    [System.Windows.Forms.GroupBox]::new()
$sourceGroup.Text = "1. Source files"
$sourceGroup.Dock =
    [System.Windows.Forms.DockStyle]::Fill
$sourceGroup.Margin =
    [System.Windows.Forms.Padding]::new(
        0,
        0,
        0,
        10
    )

$sourceLayout =
    [System.Windows.Forms.TableLayoutPanel]::new()
$sourceLayout.Dock =
    [System.Windows.Forms.DockStyle]::Fill
$sourceLayout.Padding =
    [System.Windows.Forms.Padding]::new(
        10
    )
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
        180
    )
)
[void]$sourceLayout.RowStyles.Add(
    [System.Windows.Forms.RowStyle]::new(
        [System.Windows.Forms.SizeType]::Percent,
        100
    )
)

$fileList =
    [System.Windows.Forms.ListBox]::new()
$fileList.Dock =
    [System.Windows.Forms.DockStyle]::Fill
$fileList.HorizontalScrollbar = $true
$fileList.SelectionMode =
    [System.Windows.Forms.SelectionMode]::MultiExtended
$fileList.Margin =
    [System.Windows.Forms.Padding]::new(
        0,
        0,
        10,
        0
    )

$sourceButtons =
    [System.Windows.Forms.FlowLayoutPanel]::new()
$sourceButtons.Dock =
    [System.Windows.Forms.DockStyle]::Fill
$sourceButtons.FlowDirection =
    [System.Windows.Forms.FlowDirection]::TopDown
$sourceButtons.WrapContents = $false
$sourceButtons.AutoScroll = $false

$addFilesButton =
    New-Button `
        -Text "Add files..." `
        -Width 155

$removeFilesButton =
    New-Button `
        -Text "Remove selected" `
        -Width 155

$clearFilesButton =
    New-Button `
        -Text "Clear list" `
        -Width 155

$copyFilesButton =
    New-Button `
        -Text "Copy selected files" `
        -Width 155

$fileCountTextBox =
    [System.Windows.Forms.TextBox]::new()
$fileCountTextBox.ReadOnly = $true
$fileCountTextBox.BorderStyle =
    [System.Windows.Forms.BorderStyle]::None
$fileCountTextBox.Width = 155
$fileCountTextBox.Text = "0 files selected"
$fileCountTextBox.Margin =
    [System.Windows.Forms.Padding]::new(
        0,
        4,
        0,
        0
    )

[void]$sourceButtons.Controls.Add(
    $addFilesButton
)
[void]$sourceButtons.Controls.Add(
    $removeFilesButton
)
[void]$sourceButtons.Controls.Add(
    $clearFilesButton
)
[void]$sourceButtons.Controls.Add(
    $copyFilesButton
)
[void]$sourceButtons.Controls.Add(
    $fileCountTextBox
)

[void]$sourceLayout.Controls.Add(
    $fileList,
    0,
    0
)
[void]$sourceLayout.Controls.Add(
    $sourceButtons,
    1,
    0
)
[void]$sourceGroup.Controls.Add(
    $sourceLayout
)

$optionsGroup =
    [System.Windows.Forms.GroupBox]::new()
$optionsGroup.Text = "2. Build options"
$optionsGroup.Dock =
    [System.Windows.Forms.DockStyle]::Fill
$optionsGroup.AutoSize = $true
$optionsGroup.Margin =
    [System.Windows.Forms.Padding]::new(
        0,
        0,
        0,
        10
    )

$optionsLayout =
    [System.Windows.Forms.TableLayoutPanel]::new()
$optionsLayout.Dock =
    [System.Windows.Forms.DockStyle]::Fill
$optionsLayout.AutoSize = $true
$optionsLayout.Padding =
    [System.Windows.Forms.Padding]::new(
        10
    )
$optionsLayout.ColumnCount = 3
$optionsLayout.RowCount = 3

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

$outputLabel =
    [System.Windows.Forms.Label]::new()
$outputLabel.Text = "Output directory:"
$outputLabel.AutoSize = $true
$outputLabel.Anchor =
    [System.Windows.Forms.AnchorStyles]::Left

$outputTextBox =
    [System.Windows.Forms.TextBox]::new()
$outputTextBox.Text =
    $defaultOutputDirectory
$outputTextBox.Dock =
    [System.Windows.Forms.DockStyle]::Fill

$browseOutputButton =
    New-Button `
        -Text "Browse..." `
        -Width 120

$chunkLabel =
    [System.Windows.Forms.Label]::new()
$chunkLabel.Text =
    "Labels per memory chunk:"
$chunkLabel.AutoSize = $true
$chunkLabel.Anchor =
    [System.Windows.Forms.AnchorStyles]::Left

$chunkNumeric =
    [System.Windows.Forms.NumericUpDown]::new()
$chunkNumeric.Minimum = 1000
$chunkNumeric.Maximum = 1000000
$chunkNumeric.Increment = 10000
$chunkNumeric.Value = 250000
$chunkNumeric.ThousandsSeparator = $true
$chunkNumeric.Width = 150
$chunkNumeric.Anchor =
    [System.Windows.Forms.AnchorStyles]::Left

$optionChecks =
    [System.Windows.Forms.FlowLayoutPanel]::new()
$optionChecks.AutoSize = $true
$optionChecks.Dock =
    [System.Windows.Forms.DockStyle]::Fill
$optionChecks.FlowDirection =
    [System.Windows.Forms.FlowDirection]::LeftToRight
$optionChecks.WrapContents = $true

$keepUnderscoresCheckBox =
    [System.Windows.Forms.CheckBox]::new()
$keepUnderscoresCheckBox.Text =
    "Keep underscores in labels"
$keepUnderscoresCheckBox.Checked = $true
$keepUnderscoresCheckBox.AutoSize = $true
$keepUnderscoresCheckBox.Margin =
    [System.Windows.Forms.Padding]::new(
        0,
        3,
        20,
        3
    )

$keepTemporaryCheckBox =
    [System.Windows.Forms.CheckBox]::new()
$keepTemporaryCheckBox.Text =
    "Keep temporary sorted chunks"
$keepTemporaryCheckBox.Checked = $false
$keepTemporaryCheckBox.AutoSize = $true
$keepTemporaryCheckBox.Margin =
    [System.Windows.Forms.Padding]::new(
        0,
        3,
        0,
        3
    )

[void]$optionChecks.Controls.Add(
    $keepUnderscoresCheckBox
)
[void]$optionChecks.Controls.Add(
    $keepTemporaryCheckBox
)

$warningLabel =
    [System.Windows.Forms.Label]::new()
$warningLabel.Text =
    "Temporary chunks are deleted after a successful build unless retained."
$warningLabel.AutoSize = $true
$warningLabel.ForeColor =
    [System.Drawing.Color]::DimGray

[void]$optionsLayout.Controls.Add(
    $outputLabel,
    0,
    0
)
[void]$optionsLayout.Controls.Add(
    $outputTextBox,
    1,
    0
)
[void]$optionsLayout.Controls.Add(
    $browseOutputButton,
    2,
    0
)
[void]$optionsLayout.Controls.Add(
    $chunkLabel,
    0,
    1
)
[void]$optionsLayout.Controls.Add(
    $chunkNumeric,
    1,
    1
)
[void]$optionsLayout.Controls.Add(
    $warningLabel,
    0,
    2
)
[void]$optionsLayout.Controls.Add(
    $optionChecks,
    1,
    2
)
$optionsLayout.SetColumnSpan(
    $optionChecks,
    2
)
[void]$optionsGroup.Controls.Add(
    $optionsLayout
)

$actionGroup =
    [System.Windows.Forms.GroupBox]::new()
$actionGroup.Text = "3. Build and reports"
$actionGroup.Dock =
    [System.Windows.Forms.DockStyle]::Fill
$actionGroup.AutoSize = $true
$actionGroup.Margin =
    [System.Windows.Forms.Padding]::new(
        0,
        0,
        0,
        10
    )

$actionLayout =
    [System.Windows.Forms.TableLayoutPanel]::new()
$actionLayout.Dock =
    [System.Windows.Forms.DockStyle]::Fill
$actionLayout.AutoSize = $true
$actionLayout.Padding =
    [System.Windows.Forms.Padding]::new(
        10
    )
$actionLayout.ColumnCount = 1
$actionLayout.RowCount = 3

$actionButtons =
    [System.Windows.Forms.FlowLayoutPanel]::new()
$actionButtons.Dock =
    [System.Windows.Forms.DockStyle]::Fill
$actionButtons.AutoSize = $true
$actionButtons.FlowDirection =
    [System.Windows.Forms.FlowDirection]::LeftToRight
$actionButtons.WrapContents = $true

$buildButton =
    New-Button `
        -Text "Build package" `
        -Width 140

$stopButton =
    New-Button `
        -Text "Stop" `
        -Width 95
$stopButton.Enabled = $false

$openOutputButton =
    New-Button `
        -Text "Open output" `
        -Width 120

$copyStatusButton =
    New-Button `
        -Text "Copy status" `
        -Width 115

$copyLogButton =
    New-Button `
        -Text "Copy log" `
        -Width 105

$copyReportButton =
    New-Button `
        -Text "Copy full report" `
        -Width 145

$copyInterfaceButton =
    New-Button `
        -Text "Copy interface report" `
        -Width 165

$closeOtherInstancesButton =
    New-Button `
        -Text "Close other instances" `
        -Width 165

$restartStudioButton =
    New-Button `
        -Text "Restart Studio" `
        -Width 125

foreach ($control in @(
    $buildButton,
    $stopButton,
    $openOutputButton,
    $copyStatusButton,
    $copyLogButton,
    $copyReportButton,
    $copyInterfaceButton,
    $closeOtherInstancesButton,
    $restartStudioButton
)) {
    [void]$actionButtons.Controls.Add(
        $control
    )
}

$statusTextBox =
    [System.Windows.Forms.TextBox]::new()
$statusTextBox.Text = "Ready."
$statusTextBox.ReadOnly = $true
$statusTextBox.Dock =
    [System.Windows.Forms.DockStyle]::Fill
$statusTextBox.Margin =
    [System.Windows.Forms.Padding]::new(
        0,
        2,
        0,
        7
    )

$progressBar =
    [System.Windows.Forms.ProgressBar]::new()
$progressBar.Dock =
    [System.Windows.Forms.DockStyle]::Fill
$progressBar.Style =
    [System.Windows.Forms.ProgressBarStyle]::Continuous
$progressBar.Minimum = 0
$progressBar.Maximum = 100
$progressBar.Value = 0

[void]$actionLayout.Controls.Add(
    $actionButtons,
    0,
    0
)
[void]$actionLayout.Controls.Add(
    $statusTextBox,
    0,
    1
)
[void]$actionLayout.Controls.Add(
    $progressBar,
    0,
    2
)
[void]$actionGroup.Controls.Add(
    $actionLayout
)

$logGroup =
    [System.Windows.Forms.GroupBox]::new()
$logGroup.Text = "Build log"
$logGroup.Dock =
    [System.Windows.Forms.DockStyle]::Fill
$logGroup.Margin =
    [System.Windows.Forms.Padding]::new(
        0
    )

$logTextBox =
    [System.Windows.Forms.TextBox]::new()
$logTextBox.Dock =
    [System.Windows.Forms.DockStyle]::Fill
$logTextBox.Multiline = $true
$logTextBox.ReadOnly = $true
$logTextBox.ScrollBars =
    [System.Windows.Forms.ScrollBars]::Both
$logTextBox.WordWrap = $false
$logTextBox.Font =
    [System.Drawing.Font]::new(
        "Consolas",
        9
    )

[void]$logGroup.Controls.Add(
    $logTextBox
)

[void]$root.Controls.Add(
    $titlePanel,
    0,
    0
)
[void]$root.Controls.Add(
    $sourceGroup,
    0,
    1
)
[void]$root.Controls.Add(
    $optionsGroup,
    0,
    2
)
[void]$root.Controls.Add(
    $actionGroup,
    0,
    3
)
[void]$root.Controls.Add(
    $logGroup,
    0,
    4
)
[void]$form.Controls.Add(
    $root
)

function Update-FileList {
    $fileList.BeginUpdate()

    try {
        $fileList.Items.Clear()

        foreach ($path in $selectedFiles) {
            [void]$fileList.Items.Add(
                $path
            )
        }
    }
    finally {
        $fileList.EndUpdate()
    }

    $suffix = if (
        $selectedFiles.Count -eq 1
    ) {
        ""
    }
    else {
        "s"
    }

    $fileCountTextBox.Text =
        "{0:N0} file{1} selected" -f
        $selectedFiles.Count,
        $suffix

    $copyFilesButton.Enabled =
        $selectedFiles.Count -gt 0
}

function Set-InterfaceRunning {
    param(
        [Parameter(Mandatory = $true)]
        [bool]$Running
    )

    $addFilesButton.Enabled =
        -not $Running
    $removeFilesButton.Enabled =
        -not $Running
    $clearFilesButton.Enabled =
        -not $Running
    $copyFilesButton.Enabled =
        -not $Running -and
        $selectedFiles.Count -gt 0
    $browseOutputButton.Enabled =
        -not $Running
    $outputTextBox.Enabled =
        -not $Running
    $chunkNumeric.Enabled =
        -not $Running
    $keepUnderscoresCheckBox.Enabled =
        -not $Running
    $keepTemporaryCheckBox.Enabled =
        -not $Running
    $buildButton.Enabled =
        -not $Running
    $stopButton.Enabled =
        $Running
    $openOutputButton.Enabled =
        -not $Running
    $closeOtherInstancesButton.Enabled =
        -not $Running
    $restartStudioButton.Enabled =
        -not $Running

    $copyStatusButton.Enabled =
        -not [string]::IsNullOrWhiteSpace(
            $statusTextBox.Text
        )
    $copyLogButton.Enabled =
        -not [string]::IsNullOrWhiteSpace(
            $logTextBox.Text
        )
    $copyReportButton.Enabled =
        $true
    $copyInterfaceButton.Enabled =
        $true

    if ($Running) {
        $progressBar.Style =
            [System.Windows.Forms.ProgressBarStyle]::Marquee
        $progressBar.MarqueeAnimationSpeed =
            30
    }
    else {
        $progressBar.MarqueeAnimationSpeed =
            0
        $progressBar.Style =
            [System.Windows.Forms.ProgressBarStyle]::Continuous
        $progressBar.Value = 0
    }
}

function Refresh-BuildLog {
    if (
        [string]::IsNullOrWhiteSpace(
            $script:activeLogPath
        ) -or
        -not (
            Test-Path `
                -LiteralPath $script:activeLogPath `
                -PathType Leaf
        )
    ) {
        return
    }

    try {
        $lines = @(
            Get-Content `
                -LiteralPath $script:activeLogPath `
                -ErrorAction Stop
        )

        $lineCount = @($lines).Count

        if (
            $lineCount -lt
            $script:displayedLogLineCount
        ) {
            $script:displayedLogLineCount = 0
            $logTextBox.Clear()
        }

        if (
            $lineCount -le
            $script:displayedLogLineCount
        ) {
            return
        }

        $firstNewLine =
            [int]$script:displayedLogLineCount

        $lastNewLine =
            [int]$lineCount - 1

        $newLines = @(
            if (
                $firstNewLine -eq
                $lastNewLine
            ) {
                $lines[$firstNewLine]
            }
            else {
                $lines[
                    $firstNewLine..
                    $lastNewLine
                ]
            }
        )

        $newText =
            ($newLines -join
                [Environment]::NewLine) +
            [Environment]::NewLine

        $logTextBox.AppendText(
            $newText
        )

        $logTextBox.SelectionStart =
            $logTextBox.TextLength

        $logTextBox.ScrollToCaret()

        $script:displayedLogLineCount =
            $lineCount

        $copyLogButton.Enabled =
            $lineCount -gt 0
    }
    catch {
        $statusTextBox.Text =
            "Log refresh error: " +
            $_.Exception.Message
    }
}

function Get-SelectedFileText {
    $paths = @(
        if (
            $fileList.SelectedItems.Count -gt 0
        ) {
            $fileList.SelectedItems |
                ForEach-Object {
                    [string]$_
                }
        }
        else {
            $selectedFiles |
                ForEach-Object {
                    [string]$_
                }
        }
    )

    return (
        $paths -join
        [Environment]::NewLine
    )
}

function Get-FullReport {
    $lines =
        [System.Collections.Generic.List[string]]::new()

    [void]$lines.Add(
        "LeanSERP Studio report"
    )
    [void]$lines.Add(
        "Created: " +
        (Get-Date).ToString(
            "yyyy-MM-dd HH:mm:ss"
        )
    )
    [void]$lines.Add("")
    [void]$lines.Add(
        "Status: " +
        $statusTextBox.Text
    )
    [void]$lines.Add(
        "Build running: " +
        [string](Test-BuildRunning)
    )
    [void]$lines.Add(
        "Selected files: " +
        $selectedFiles.Count
    )

    foreach ($path in $selectedFiles) {
        [void]$lines.Add(
            "  " + [string]$path
        )
    }

    [void]$lines.Add("")
    [void]$lines.Add(
        "Output directory: " +
        $outputTextBox.Text
    )
    [void]$lines.Add(
        "Labels per memory chunk: " +
        [string][int]$chunkNumeric.Value
    )
    [void]$lines.Add(
        "Keep underscores: " +
        [string]$keepUnderscoresCheckBox.Checked
    )
    [void]$lines.Add(
        "Keep temporary chunks: " +
        [string]$keepTemporaryCheckBox.Checked
    )
    [void]$lines.Add(
        "Current log file: " +
        [string]$script:activeLogPath
    )
    [void]$lines.Add("")
    [void]$lines.Add("Log:")
    [void]$lines.Add(
        $logTextBox.Text
    )

    return (
        $lines -join
        [Environment]::NewLine
    )
}

function Get-InterfaceReport {
    $lines =
        [System.Collections.Generic.List[string]]::new()

    [void]$lines.Add(
        "LeanSERP Studio interface report"
    )
    [void]$lines.Add(
        "Created: " +
        (Get-Date).ToString(
            "yyyy-MM-dd HH:mm:ss"
        )
    )
    [void]$lines.Add("")
    [void]$lines.Add(
        "Window title: " +
        $form.Text
    )
    [void]$lines.Add(
        "Window size: " +
        $form.ClientSize.Width +
        " x " +
        $form.ClientSize.Height
    )
    [void]$lines.Add(
        "Status: " +
        $statusTextBox.Text
    )
    [void]$lines.Add(
        "Build running: " +
        [string](Test-BuildRunning)
    )
    [void]$lines.Add("")
    [void]$lines.Add(
        "Source files"
    )
    [void]$lines.Add(
        "Selected file count: " +
        $selectedFiles.Count
    )

    if ($selectedFiles.Count -eq 0) {
        [void]$lines.Add(
            "  (none)"
        )
    }
    else {
        foreach ($path in $selectedFiles) {
            [void]$lines.Add(
                "  " + [string]$path
            )
        }
    }

    [void]$lines.Add("")
    [void]$lines.Add(
        "Build options"
    )
    [void]$lines.Add(
        "Output directory: " +
        $outputTextBox.Text
    )
    [void]$lines.Add(
        "Labels per memory chunk: " +
        [string][int]$chunkNumeric.Value
    )
    [void]$lines.Add(
        "Keep underscores: " +
        [string]$keepUnderscoresCheckBox.Checked
    )
    [void]$lines.Add(
        "Keep temporary chunks: " +
        [string]$keepTemporaryCheckBox.Checked
    )
    [void]$lines.Add("")
    [void]$lines.Add(
        "Controls"
    )

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
            Name = "Browse output"
            Control = $browseOutputButton
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
            Name = "Open output"
            Control = $openOutputButton
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
        [pscustomobject]@{
            Name = "Close other instances"
            Control =
                $closeOtherInstancesButton
        }
        [pscustomobject]@{
            Name = "Restart Studio"
            Control = $restartStudioButton
        }
    )

    foreach ($entry in $controls) {
        $control = $entry.Control

        [void]$lines.Add(
            "  " +
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
    [void]$lines.Add(
        "Progress"
    )
    [void]$lines.Add(
        "Style: " +
        $progressBar.Style
    )
    [void]$lines.Add(
        "Value: " +
        $progressBar.Value
    )
    [void]$lines.Add(
        "Maximum: " +
        $progressBar.Maximum
    )
    [void]$lines.Add(
        "Current log file: " +
        [string]$script:activeLogPath
    )
    [void]$lines.Add(
        "Visible log characters: " +
        $logTextBox.TextLength
    )

    return (
        $lines -join
        [Environment]::NewLine
    )
}

function Start-StudioBuild {
    if ($selectedFiles.Count -eq 0) {
        [void][System.Windows.Forms.MessageBox]::Show(
            "Add at least one source file first.",
            "LeanSERP Studio",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Information
        )
        return
    }

    $outputDirectory =
        $outputTextBox.Text.Trim()

    if (
        [string]::IsNullOrWhiteSpace(
            $outputDirectory
        )
    ) {
        [void][System.Windows.Forms.MessageBox]::Show(
            "Select an output directory.",
            "LeanSERP Studio",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Warning
        )
        return
    }

    [void](
        New-Item `
            -ItemType Directory `
            -Path $outputDirectory `
            -Force
    )

    $logDirectory =
        Join-Path `
            $outputDirectory `
            "logs"

    [void](
        New-Item `
            -ItemType Directory `
            -Path $logDirectory `
            -Force
    )

    $timestamp =
        Get-Date -Format "yyyyMMdd-HHmmss"

    $script:activeLogPath =
        Join-Path `
            $logDirectory `
            (
                "studio-build-" +
                $timestamp +
                ".log"
            )

    [System.IO.File]::WriteAllText(
        $script:activeLogPath,
        "",
        [System.Text.UTF8Encoding]::new(
            $false
        )
    )

    $script:displayedLogLineCount = 0
    $script:buildStartedAt = Get-Date
    $script:buildOutputDirectory =
        $outputDirectory
    $script:stopRequested = $false

    $logTextBox.Clear()

    $argumentParts =
        [System.Collections.Generic.List[string]]::new()

    [void]$argumentParts.Add(
        "-NoProfile"
    )
    [void]$argumentParts.Add(
        "-ExecutionPolicy"
    )
    [void]$argumentParts.Add(
        "Bypass"
    )
    [void]$argumentParts.Add(
        "-File"
    )

    $quotedRunnerPath =
        Quote-ProcessArgument `
            -Value $runnerPath

    [void]$argumentParts.Add(
        $quotedRunnerPath
    )
    [void]$argumentParts.Add(
        "-BuilderPath"
    )

    $quotedBuilderPath =
        Quote-ProcessArgument `
            -Value $builderPath

    [void]$argumentParts.Add(
        $quotedBuilderPath
    )

$script:activeInputListPath =
    Join-Path `
        $logDirectory `
        (
            "studio-inputs-" +
            $timestamp +
            ".txt"
        )

[System.IO.File]::WriteAllLines(
    $script:activeInputListPath,
    [string[]]$selectedFiles.ToArray(),
    [System.Text.UTF8Encoding]::new(
        $false
    )
)

[void]$argumentParts.Add(
    "-InputListFile"
)

$quotedInputListPath =
    Quote-ProcessArgument `
        -Value $script:activeInputListPath

[void]$argumentParts.Add(
    $quotedInputListPath
)

    [void]$argumentParts.Add(
        "-OutputDirectory"
    )

    $quotedOutputDirectory =
        Quote-ProcessArgument `
            -Value $outputDirectory

    [void]$argumentParts.Add(
        $quotedOutputDirectory
    )
    [void]$argumentParts.Add(
        "-LogPath"
    )

    $quotedLogPath =
        Quote-ProcessArgument `
            -Value $script:activeLogPath

    [void]$argumentParts.Add(
        $quotedLogPath
    )
    [void]$argumentParts.Add(
        "-ChunkSize"
    )
    [void]$argumentParts.Add(
        [string][int]$chunkNumeric.Value
    )

    if (
        $keepUnderscoresCheckBox.Checked
    ) {
        [void]$argumentParts.Add(
            "-KeepUnderscores"
        )
    }

    if (
        $keepTemporaryCheckBox.Checked
    ) {
        [void]$argumentParts.Add(
            "-KeepTemporaryFiles"
        )
    }

    $startInfo =
        [System.Diagnostics.ProcessStartInfo]::new()

    $startInfo.FileName =
        "powershell.exe"
    $startInfo.Arguments =
        $argumentParts -join " "
    $startInfo.UseShellExecute =
        $false
    $startInfo.CreateNoWindow =
        $true

    $process =
        [System.Diagnostics.Process]::new()

    $process.StartInfo =
        $startInfo

    try {
        [void]$process.Start()
    }
    catch {
        $process.Dispose()

        [void][System.Windows.Forms.MessageBox]::Show(
            (
                "Could not start the build runner:`r`n" +
                $_.Exception.Message
            ),
            "LeanSERP Studio",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error
        )

        return
    }

    $script:activeProcess =
        $process

    $statusTextBox.Text =
        "Build running..."

    Set-InterfaceRunning `
        -Running $true

    $timer.Start()
}

$timer =
    [System.Windows.Forms.Timer]::new()

$timer.Interval = 500

$timer.Add_Tick({
    try {
        Refresh-BuildLog

        if (
            $null -ne $script:activeProcess -and
            $script:activeProcess.HasExited
        ) {
            $exitCode =
                $script:activeProcess.ExitCode

            try {
                $script:activeProcess.WaitForExit()
            }
            catch {
            }

            Refresh-BuildLog

            $script:activeProcess.Dispose()
            $script:activeProcess =
                $null

            $timer.Stop()

            if (
    -not [string]::IsNullOrWhiteSpace(
        $script:activeInputListPath
    ) -and
    (
        Test-Path `
            -LiteralPath $script:activeInputListPath `
            -PathType Leaf
    )
) {
    Remove-Item `
        -LiteralPath $script:activeInputListPath `
        -Force `
        -ErrorAction SilentlyContinue
}

$script:activeInputListPath = ""

            if ($script:stopRequested) {
                $statusTextBox.Text =
                    "Build stopped."
            }
            elseif ($exitCode -eq 0) {
                $statusTextBox.Text =
                    "Build completed successfully."
            }
            else {
                $statusTextBox.Text =
                    "Build failed. Exit code: " +
                    $exitCode
            }

            Set-InterfaceRunning `
                -Running $false

            if ($script:stopRequested) {
                Offer-IncompleteBuildCleanup
            }
        }
    }
    catch {
        $timer.Stop()

        $statusTextBox.Text =
            "Timer error: " +
            $_.Exception.Message

        Set-InterfaceRunning `
            -Running $false

        [void][System.Windows.Forms.MessageBox]::Show(
            (
                "A GUI timer operation failed:`r`n" +
                $_.Exception.Message
            ),
            "LeanSERP Studio",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error
        )
    }
})

$addFilesButton.Add_Click({
    $dialog =
        [System.Windows.Forms.OpenFileDialog]::new()

    $dialog.Title =
        "Select LeanSERP source files"

    $dialog.Filter =
        "Text and list files|*.txt;*.list;*.dat|All files|*.*"

    $dialog.Multiselect =
        $true
    $dialog.CheckFileExists =
        $true

    try {
        if (
            $dialog.ShowDialog() -eq
            [System.Windows.Forms.DialogResult]::OK
        ) {
            foreach (
                $selectedPath in
                    $dialog.FileNames
            ) {
                if (
                    -not $selectedFiles.Contains(
                        $selectedPath
                    )
                ) {
                    [void]$selectedFiles.Add(
                        $selectedPath
                    )
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

    foreach ($selectedPath in $paths) {
        [void]$selectedFiles.Remove(
            $selectedPath
        )
    }

    Update-FileList
})

$clearFilesButton.Add_Click({
    $selectedFiles.Clear()
    Update-FileList
})

$copyFilesButton.Add_Click({
    Set-ClipboardText `
        -Text (
            Get-SelectedFileText
        ) `
        -Description "selected file paths"
})

$browseOutputButton.Add_Click({
    $dialog =
        [System.Windows.Forms.FolderBrowserDialog]::new()

    $dialog.Description =
        "Select the LeanSERP output directory"

    $dialog.SelectedPath =
        $outputTextBox.Text

    try {
        if (
            $dialog.ShowDialog() -eq
            [System.Windows.Forms.DialogResult]::OK
        ) {
            $outputTextBox.Text =
                $dialog.SelectedPath
        }
    }
    finally {
        $dialog.Dispose()
    }
})

$buildButton.Add_Click({
    Start-StudioBuild
})

$stopButton.Add_Click({
    if (
        -not (Test-BuildRunning)
    ) {
        return
    }

    $confirmed =
        [System.Windows.Forms.MessageBox]::Show(
            "Stop the current build?",
            "LeanSERP Studio",
            [System.Windows.Forms.MessageBoxButtons]::YesNo,
            [System.Windows.Forms.MessageBoxIcon]::Warning
        )

    if (
        $confirmed -ne
        [System.Windows.Forms.DialogResult]::Yes
    ) {
        return
    }

    $script:stopRequested =
        $true
    $statusTextBox.Text =
        "Stopping build..."
    $stopButton.Enabled =
        $false

    try {
        Stop-ProcessTree `
            -ProcessId $script:activeProcess.Id
    }
    catch {
    }
})

$openOutputButton.Add_Click({
    $outputPath =
        $outputTextBox.Text.Trim()

    if (
        -not (
            Test-Path `
                -LiteralPath $outputPath `
                -PathType Container
        )
    ) {
        [void](
            New-Item `
                -ItemType Directory `
                -Path $outputPath `
                -Force
        )
    }

    [void](
        Start-Process `
            -FilePath "explorer.exe" `
            -ArgumentList @(
                $outputPath
            )
    )
})

$copyStatusButton.Add_Click({
    Set-ClipboardText `
        -Text $statusTextBox.Text `
        -Description "status"
})

$copyLogButton.Add_Click({
    Set-ClipboardText `
        -Text $logTextBox.Text `
        -Description "log"
})

$copyReportButton.Add_Click({
    Set-ClipboardText `
        -Text (
            Get-FullReport
        ) `
        -Description "full report"
})

$copyInterfaceButton.Add_Click({
    Set-ClipboardText `
        -Text (
            Get-InterfaceReport
        ) `
        -Description "interface report"
})

$closeOtherInstancesButton.Add_Click({
    if (Test-BuildRunning) {
        [void][System.Windows.Forms.MessageBox]::Show(
            "Stop the active build first.",
            "LeanSERP Studio",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Warning
        )

        return
    }

    $result =
        Close-OtherStudioProcesses

    $message =
        "Closed " +
        $result.Closed +
        " other LeanSERP Studio instance" +
        $(if ($result.Closed -eq 1) {
            "."
        } else {
            "s."
        })

    if ($result.Failures.Count -gt 0) {
        $message +=
            "`r`n`r`nFailures:`r`n" +
            (
                $result.Failures -join
                "`r`n"
            )
    }

    $icon = if (
        $result.Failures.Count -gt 0
    ) {
        [System.Windows.Forms.MessageBoxIcon]::Warning
    }
    else {
        [System.Windows.Forms.MessageBoxIcon]::Information
    }

    [void][System.Windows.Forms.MessageBox]::Show(
        $message,
        "LeanSERP Studio",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        $icon
    )
})

$restartStudioButton.Add_Click({
    if (Test-BuildRunning) {
        [void][System.Windows.Forms.MessageBox]::Show(
            "Stop the active build first.",
            "LeanSERP Studio",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Warning
        )

        return
    }

    [void](
        Close-OtherStudioProcesses
    )

    $arguments =
        "-NoProfile " +
        "-ExecutionPolicy Bypass " +
        "-STA " +
        "-WindowStyle Hidden " +
        "-File " +
        (
            Quote-ProcessArgument `
                -Value $scriptPath
        )

    try {
        [void](
            Start-Process `
                -FilePath "powershell.exe" `
                -ArgumentList $arguments `
                -WindowStyle Hidden `
                -ErrorAction Stop
        )

        $form.Close()
    }
    catch {
        [void][System.Windows.Forms.MessageBox]::Show(
            (
                "Could not restart Studio:`r`n" +
                $_.Exception.Message
            ),
            "LeanSERP Studio",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error
        )
    }
})

$form.Add_FormClosing({
    param(
        [object]$sender,
        [System.Windows.Forms.FormClosingEventArgs]$event
    )

    if (
        -not (Test-BuildRunning)
    ) {
        return
    }

    $choice =
        [System.Windows.Forms.MessageBox]::Show(
            "A build is running. Stop it and close Studio?",
            "LeanSERP Studio",
            [System.Windows.Forms.MessageBoxButtons]::YesNo,
            [System.Windows.Forms.MessageBoxIcon]::Warning
        )

    if (
        $choice -ne
        [System.Windows.Forms.DialogResult]::Yes
    ) {
        $event.Cancel = $true
        return
    }

    $script:stopRequested =
        $true

    try {
        Stop-ProcessTree `
            -ProcessId $script:activeProcess.Id
    }
    catch {
    }
})

$form.Add_FormClosed({
    $timer.Stop()
    $timer.Dispose()

    if (
        $null -ne $script:activeProcess
    ) {
        try {
            if (
                -not $script:activeProcess.HasExited
            ) {
                Stop-ProcessTree `
                    -ProcessId $script:activeProcess.Id
            }
        }
        catch {
        }

        try {
            $script:activeProcess.Dispose()
        }
        catch {
        }

        $script:activeProcess =
            $null
    }
    if (
    -not [string]::IsNullOrWhiteSpace(
        $script:activeInputListPath
    ) -and
    (
        Test-Path `
            -LiteralPath $script:activeInputListPath `
            -PathType Leaf
    )
) {
    Remove-Item `
        -LiteralPath $script:activeInputListPath `
        -Force `
        -ErrorAction SilentlyContinue
}

$script:activeInputListPath = ""
})

Update-FileList

Set-InterfaceRunning `
    -Running $false

$null = $form.ShowDialog()

$form.Dispose()
