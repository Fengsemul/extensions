using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

internal static class ApplyApprovedOverrides
{
    private sealed class Options
    {
        public string InputBuild = "";
        public string ApprovedRulesDirectory = "";
        public string OutputDirectory = "";
    }

    private sealed class Report
    {
        public string Format { get; set; } =
            "leanserp-approved-overrides";
        public int Version { get; set; } = 1;
        public string CreatedAt { get; set; } = "";
        public string SourceBuild { get; set; } = "";
        public long OriginalLabelCount { get; set; }
        public long FinalLabelCount { get; set; }
        public int ApprovedOverrideCount { get; set; }
        public int UsedOverrideCount { get; set; }
        public int AddedLabelCount { get; set; }
        public int ApprovedExactHostCount { get; set; }
        public int UsedExactHostCount { get; set; }
        public string LabelsSha256 { get; set; } = "";
        public string OverridesSha256 { get; set; } = "";
        public string ExactHostsSha256 { get; set; } = "";
        public string[] UsedOverrides { get; set; } =
            Array.Empty<string>();
        public string[] UsedExactHosts { get; set; } =
            Array.Empty<string>();
    }

    private static int Main(string[] args)
    {
        try
        {
            Options options = ParseOptions(args);
            ValidateOptions(options);

            string inputLabels = Path.Combine(
                options.InputBuild,
                "labels.txt"
            );
            string pslOnlyInput = Path.Combine(
                options.InputBuild,
                "public-suffix-only.tsv"
            );
            string approvedOverridesPath = Path.Combine(
                options.ApprovedRulesDirectory,
                "psl-label-overrides-approved.txt"
            );
            string approvedExactHostsPath = Path.Combine(
                options.ApprovedRulesDirectory,
                "exact-host-blocks-approved.txt"
            );

            var approvedOverrides = LoadLabels(
                approvedOverridesPath
            );
            var approvedExactHosts = LoadHostnames(
                approvedExactHostsPath
            );

            var usedOverrides = new HashSet<string>(
                StringComparer.Ordinal
            );
            var usedExactHosts = new HashSet<string>(
                StringComparer.Ordinal
            );

            ScanPslOnlyHosts(
                pslOnlyInput,
                approvedOverrides,
                approvedExactHosts,
                usedOverrides,
                usedExactHosts
            );

            string timestamp =
                DateTime.Now.ToString(
                    "yyyyMMdd-HHmmss",
                    CultureInfo.InvariantCulture
                );

            string outputBuild = Path.Combine(
                options.OutputDirectory,
                "approved-build-" + timestamp
            );

            Directory.CreateDirectory(outputBuild);

            string outputLabels = Path.Combine(
                outputBuild,
                "labels.txt"
            );
            string outputOverrides = Path.Combine(
                outputBuild,
                "psl-label-overrides.txt"
            );
            string outputExactHosts = Path.Combine(
                outputBuild,
                "exact-host-blocks.txt"
            );
            string outputReport = Path.Combine(
                outputBuild,
                "approved-overrides-report.json"
            );

            var sortedOverrides = usedOverrides.ToArray();
            Array.Sort(
                sortedOverrides,
                StringComparer.Ordinal
            );

            var sortedExactHosts = usedExactHosts.ToArray();
            Array.Sort(
                sortedExactHosts,
                StringComparer.Ordinal
            );

            File.WriteAllLines(
                outputOverrides,
                sortedOverrides,
                new UTF8Encoding(false)
            );

            File.WriteAllLines(
                outputExactHosts,
                sortedExactHosts,
                new UTF8Encoding(false)
            );

            (
                long originalLabelCount,
                long finalLabelCount,
                int addedLabelCount
            ) = MergeLabelsAndOverrides(
                inputLabels,
                sortedOverrides,
                outputLabels
            );

            var report = new Report
            {
                CreatedAt =
                    DateTimeOffset.UtcNow.ToString("O"),
                SourceBuild =
                    Path.GetFullPath(options.InputBuild),
                OriginalLabelCount =
                    originalLabelCount,
                FinalLabelCount =
                    finalLabelCount,
                ApprovedOverrideCount =
                    approvedOverrides.Count,
                UsedOverrideCount =
                    sortedOverrides.Length,
                AddedLabelCount =
                    addedLabelCount,
                ApprovedExactHostCount =
                    approvedExactHosts.Count,
                UsedExactHostCount =
                    sortedExactHosts.Length,
                LabelsSha256 =
                    ComputeSha256(outputLabels),
                OverridesSha256 =
                    ComputeSha256(outputOverrides),
                ExactHostsSha256 =
                    ComputeSha256(outputExactHosts),
                UsedOverrides =
                    sortedOverrides,
                UsedExactHosts =
                    sortedExactHosts
            };

            string json = JsonSerializer.Serialize(
                report,
                new JsonSerializerOptions
                {
                    WriteIndented = true
                }
            );

            File.WriteAllText(
                outputReport,
                json + Environment.NewLine,
                new UTF8Encoding(false)
            );

            Console.WriteLine(
                "Approved override processing completed."
            );
            Console.WriteLine(
                "Approved overrides: {0:N0}",
                approvedOverrides.Count
            );
            Console.WriteLine(
                "Used overrides: {0:N0}",
                sortedOverrides.Length
            );
            Console.WriteLine(
                "Labels added: {0:N0}",
                addedLabelCount
            );
            Console.WriteLine(
                "Original labels: {0:N0}",
                originalLabelCount
            );
            Console.WriteLine(
                "Final labels: {0:N0}",
                finalLabelCount
            );
            Console.WriteLine(
                "Used exact hosts: {0:N0}",
                sortedExactHosts.Length
            );
            Console.WriteLine("Output:");
            Console.WriteLine(outputBuild);
            Console.WriteLine("Labels SHA-256:");
            Console.WriteLine(report.LabelsSha256);

            return 0;
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine(
                "APPROVED OVERRIDE ERROR"
            );
            Console.Error.WriteLine(exception);
            return 1;
        }
    }

    private static Options ParseOptions(string[] args)
    {
        var options = new Options();

        for (
            int index = 0;
            index < args.Length;
            index++
        )
        {
            string argument =
                args[index].ToLowerInvariant();

            switch (argument)
            {
                case "--input-build":
                    options.InputBuild =
                        RequireValue(args, ref index);
                    break;

                case "--approved-rules":
                    options.ApprovedRulesDirectory =
                        RequireValue(args, ref index);
                    break;

                case "--output":
                    options.OutputDirectory =
                        RequireValue(args, ref index);
                    break;

                default:
                    throw new ArgumentException(
                        "Unknown argument: " +
                        args[index]
                    );
            }
        }

        return options;
    }

    private static string RequireValue(
        string[] args,
        ref int index
    )
    {
        index++;

        if (index >= args.Length)
        {
            throw new ArgumentException(
                "A command-line argument is missing its value."
            );
        }

        return args[index];
    }

    private static void ValidateOptions(
        Options options
    )
    {
        if (
            string.IsNullOrWhiteSpace(
                options.InputBuild
            ) ||
            !Directory.Exists(options.InputBuild)
        )
        {
            throw new DirectoryNotFoundException(
                "The compiled input build was not found."
            );
        }

        if (
            string.IsNullOrWhiteSpace(
                options.ApprovedRulesDirectory
            ) ||
            !Directory.Exists(
                options.ApprovedRulesDirectory
            )
        )
        {
            throw new DirectoryNotFoundException(
                "The approved-rules directory was not found."
            );
        }

        if (
            string.IsNullOrWhiteSpace(
                options.OutputDirectory
            )
        )
        {
            throw new ArgumentException(
                "The output directory is missing."
            );
        }

        string labelsPath = Path.Combine(
            options.InputBuild,
            "labels.txt"
        );

        string pslOnlyPath = Path.Combine(
            options.InputBuild,
            "public-suffix-only.tsv"
        );

        if (!File.Exists(labelsPath))
        {
            throw new FileNotFoundException(
                "The compiled labels file was not found.",
                labelsPath
            );
        }

        if (!File.Exists(pslOnlyPath))
        {
            throw new FileNotFoundException(
                "The PSL-only report was not found.",
                pslOnlyPath
            );
        }

        Directory.CreateDirectory(
            options.OutputDirectory
        );
    }

    private static HashSet<string> LoadLabels(
        string path
    )
    {
        var output = new HashSet<string>(
            StringComparer.Ordinal
        );

        if (!File.Exists(path))
        {
            return output;
        }

        foreach (string rawLine in File.ReadLines(path))
        {
            string label = NormalizeLabel(rawLine);

            if (label.Length != 0)
            {
                output.Add(label);
            }
        }

        return output;
    }

    private static HashSet<string> LoadHostnames(
        string path
    )
    {
        var output = new HashSet<string>(
            StringComparer.Ordinal
        );

        if (!File.Exists(path))
        {
            return output;
        }

        foreach (string rawLine in File.ReadLines(path))
        {
            string hostname =
                NormalizeHostname(rawLine);

            if (hostname.Length != 0)
            {
                output.Add(hostname);
            }
        }

        return output;
    }

    private static void ScanPslOnlyHosts(
        string pslOnlyPath,
        HashSet<string> approvedOverrides,
        HashSet<string> approvedExactHosts,
        HashSet<string> usedOverrides,
        HashSet<string> usedExactHosts
    )
    {
        bool firstLine = true;

        foreach (string rawLine in File.ReadLines(pslOnlyPath))
        {
            if (firstLine)
            {
                firstLine = false;

                if (
                    rawLine.StartsWith(
                        "hostname\t",
                        StringComparison.OrdinalIgnoreCase
                    )
                )
                {
                    continue;
                }
            }

            string[] fields = rawLine.Split('\t');

            if (fields.Length == 0)
            {
                continue;
            }

            string hostname =
                NormalizeHostname(fields[0]);

            if (hostname.Length == 0)
            {
                continue;
            }

            if (approvedExactHosts.Contains(hostname))
            {
                usedExactHosts.Add(hostname);
            }

            foreach (string label in hostname.Split('.'))
            {
                if (approvedOverrides.Contains(label))
                {
                    usedOverrides.Add(label);
                }
            }
        }
    }

    private static (
        long OriginalCount,
        long FinalCount,
        int AddedCount
    ) MergeLabelsAndOverrides(
        string inputLabels,
        string[] sortedOverrides,
        string outputLabels
    )
    {
        using var reader = new StreamReader(
            inputLabels,
            new UTF8Encoding(false, false),
            true,
            1024 * 1024
        );

        using var writer = new StreamWriter(
            outputLabels,
            false,
            new UTF8Encoding(false),
            1024 * 1024
        );

        long originalCount = 0;
        long finalCount = 0;
        int overrideIndex = 0;
        int addedCount = 0;
        string? currentLabel = reader.ReadLine();
        string? lastWritten = null;

        while (
            currentLabel != null ||
            overrideIndex < sortedOverrides.Length
        )
        {
            string nextValue;
            bool fromOverride = false;

            if (currentLabel == null)
            {
                nextValue =
                    sortedOverrides[overrideIndex++];
                fromOverride = true;
            }
            else if (
                overrideIndex >=
                sortedOverrides.Length
            )
            {
                nextValue = currentLabel;
                currentLabel = reader.ReadLine();
                originalCount++;
            }
            else
            {
                int comparison =
                    string.CompareOrdinal(
                        currentLabel,
                        sortedOverrides[overrideIndex]
                    );

                if (comparison <= 0)
                {
                    nextValue = currentLabel;
                    currentLabel = reader.ReadLine();
                    originalCount++;

                    if (comparison == 0)
                    {
                        overrideIndex++;
                    }
                }
                else
                {
                    nextValue =
                        sortedOverrides[overrideIndex++];
                    fromOverride = true;
                }
            }

            if (
                lastWritten == null ||
                !string.Equals(
                    lastWritten,
                    nextValue,
                    StringComparison.Ordinal
                )
            )
            {
                writer.WriteLine(nextValue);
                lastWritten = nextValue;
                finalCount++;

                if (fromOverride)
                {
                    addedCount++;
                }
            }
        }

        return (
            originalCount,
            finalCount,
            addedCount
        );
    }

    private static string NormalizeLabel(
        string value
    )
    {
        string label = RemoveBomArtifacts(value)
            .Trim()
            .ToLowerInvariant()
            .Trim('.');

        if (
            label.Length == 0 ||
            label.Length > 63 ||
            label[0] == '-' ||
            label[label.Length - 1] == '-'
        )
        {
            return "";
        }

        foreach (char character in label)
        {
            bool valid =
                character >= 'a' &&
                character <= 'z' ||
                character >= '0' &&
                character <= '9' ||
                character == '-' ||
                character == '_';

            if (!valid)
            {
                return "";
            }
        }

        return label;
    }

    private static string NormalizeHostname(
        string value
    )
    {
        string hostname = RemoveBomArtifacts(value)
            .Trim()
            .ToLowerInvariant()
            .Trim('.');

        if (
            hostname.Length == 0 ||
            hostname.Length > 253 ||
            hostname.IndexOf(':') >= 0 ||
            hostname.IndexOf('.') < 0 ||
            hostname.Contains("..")
        )
        {
            return "";
        }

        string[] labels = hostname.Split('.');

        foreach (string label in labels)
        {
            if (
                label.Length == 0 ||
                label.Length > 63 ||
                label[0] == '-' ||
                label[label.Length - 1] == '-'
            )
            {
                return "";
            }

            foreach (char character in label)
            {
                bool valid =
                    character >= 'a' &&
                    character <= 'z' ||
                    character >= '0' &&
                    character <= '9' ||
                    character == '-' ||
                    character == '_';

                if (!valid)
                {
                    return "";
                }
            }
        }

        return hostname;
    }

    private static string RemoveBomArtifacts(
        string value
    )
    {
        string text =
            (value ?? "").TrimStart('\uFEFF');

        while (
            text.StartsWith(
                "\u00EF\u00BB\u00BF",
                StringComparison.Ordinal
            )
        )
        {
            text = text.Substring(3);
        }

        while (
            text.StartsWith(
                "\u00EF\u00BF\u00BD",
                StringComparison.Ordinal
            )
        )
        {
            text = text.Substring(3);
        }

        return text;
    }

    private static string ComputeSha256(
        string path
    )
    {
        using SHA256 sha256 =
            SHA256.Create();

        using FileStream stream =
            new FileStream(
                path,
                FileMode.Open,
                FileAccess.Read,
                FileShare.Read,
                1024 * 1024,
                FileOptions.SequentialScan
            );

        byte[] hash =
            sha256.ComputeHash(stream);

        var output = new StringBuilder(
            hash.Length * 2
        );

        foreach (byte value in hash)
        {
            output.Append(
                value.ToString(
                    "x2",
                    CultureInfo.InvariantCulture
                )
            );
        }

        return output.ToString();
    }
}
