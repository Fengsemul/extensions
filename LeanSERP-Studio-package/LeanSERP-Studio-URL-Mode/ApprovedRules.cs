using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

internal sealed class ApprovedRules
{
    private readonly HashSet<string> exactHostBlocks;
    private readonly HashSet<string> pslLabelOverrides;

    private ApprovedRules(
        HashSet<string> exactHostBlocks,
        HashSet<string> pslLabelOverrides)
    {
        this.exactHostBlocks = exactHostBlocks;
        this.pslLabelOverrides = pslLabelOverrides;
    }

    public int ExactHostBlockCount
    {
        get { return exactHostBlocks.Count; }
    }

    public int PslLabelOverrideCount
    {
        get { return pslLabelOverrides.Count; }
    }

    public static ApprovedRules Load(
        string approvedRulesDirectory)
    {
        if (string.IsNullOrWhiteSpace(
            approvedRulesDirectory))
        {
            throw new ArgumentException(
                "The approved-rules directory is missing.",
                nameof(approvedRulesDirectory));
        }

        string fullDirectory =
            Path.GetFullPath(approvedRulesDirectory);

        if (!Directory.Exists(fullDirectory))
        {
            throw new DirectoryNotFoundException(
                "The approved-rules directory was not found: " +
                fullDirectory);
        }

        string exactHostPath = Path.Combine(
            fullDirectory,
            "exact-host-blocks-approved.txt");

        string overridePath = Path.Combine(
            fullDirectory,
            "psl-label-overrides-approved.txt");

        HashSet<string> exactHosts =
            LoadExactHostnames(exactHostPath);

        HashSet<string> overrides =
            LoadLabels(overridePath);

        return new ApprovedRules(
            exactHosts,
            overrides);
    }

    public bool IsExactHostBlocked(
        string hostname)
    {
        string normalized =
            NormalizeHostname(hostname);

        return normalized.Length != 0 &&
            exactHostBlocks.Contains(normalized);
    }

    public bool IsPslLabelOverride(
        string label)
    {
        string normalized =
            NormalizeLabel(label);

        return normalized.Length != 0 &&
            pslLabelOverrides.Contains(normalized);
    }

    public string[] GetMatchingPslOverrides(
        IReadOnlyList<string> suffixLabels)
    {
        if (
            suffixLabels == null ||
            suffixLabels.Count == 0)
        {
            return Array.Empty<string>();
        }

        var matches = new HashSet<string>(
            StringComparer.OrdinalIgnoreCase);

        foreach (string value in suffixLabels)
        {
            string label =
                NormalizeLabel(value);

            if (
                label.Length != 0 &&
                pslLabelOverrides.Contains(label))
            {
                matches.Add(label);
            }
        }

        string[] output = matches.ToArray();
        Array.Sort(
            output,
            StringComparer.Ordinal);

        return output;
    }

    public string[] GetExactHostBlocks()
    {
        string[] output =
            exactHostBlocks.ToArray();

        Array.Sort(
            output,
            StringComparer.Ordinal);

        return output;
    }

    public string[] GetPslLabelOverrides()
    {
        string[] output =
            pslLabelOverrides.ToArray();

        Array.Sort(
            output,
            StringComparer.Ordinal);

        return output;
    }

    public void WriteUsedRules(
        string outputDirectory,
        IEnumerable<string> usedExactHosts,
        IEnumerable<string> usedPslOverrides)
    {
        if (string.IsNullOrWhiteSpace(
            outputDirectory))
        {
            throw new ArgumentException(
                "The output directory is missing.",
                nameof(outputDirectory));
        }

        Directory.CreateDirectory(
            outputDirectory);

        string exactHostPath = Path.Combine(
            outputDirectory,
            "exact-host-blocks.txt");

        string overridePath = Path.Combine(
            outputDirectory,
            "psl-label-overrides.txt");

        WriteSortedUnique(
            exactHostPath,
            usedExactHosts,
            NormalizeHostname);

        WriteSortedUnique(
            overridePath,
            usedPslOverrides,
            NormalizeLabel);
    }

    public ApprovedRulesMetadata CreateMetadata(
        string approvedRulesDirectory,
        IEnumerable<string> usedExactHosts,
        IEnumerable<string> usedPslOverrides)
    {
        string fullDirectory =
            Path.GetFullPath(
                approvedRulesDirectory);

        string exactSource = Path.Combine(
            fullDirectory,
            "exact-host-blocks-approved.txt");

        string overrideSource = Path.Combine(
            fullDirectory,
            "psl-label-overrides-approved.txt");

        string[] exactUsed = NormalizeCollection(
            usedExactHosts,
            NormalizeHostname);

        string[] overridesUsed = NormalizeCollection(
            usedPslOverrides,
            NormalizeLabel);

        return new ApprovedRulesMetadata
        {
            ApprovedRulesDirectory =
                fullDirectory,
            ApprovedExactHostCount =
                exactHostBlocks.Count,
            ApprovedPslOverrideCount =
                pslLabelOverrides.Count,
            UsedExactHostCount =
                exactUsed.Length,
            UsedPslOverrideCount =
                overridesUsed.Length,
            ExactHostSource =
                exactSource,
            PslOverrideSource =
                overrideSource,
            ExactHostSourceSha256 =
                File.Exists(exactSource)
                    ? ComputeSha256(exactSource)
                    : "",
            PslOverrideSourceSha256 =
                File.Exists(overrideSource)
                    ? ComputeSha256(overrideSource)
                    : "",
            UsedExactHosts =
                exactUsed,
            UsedPslOverrides =
                overridesUsed
        };
    }

    public string CreateMetadataJson(
        string approvedRulesDirectory,
        IEnumerable<string> usedExactHosts,
        IEnumerable<string> usedPslOverrides)
    {
        ApprovedRulesMetadata metadata =
            CreateMetadata(
                approvedRulesDirectory,
                usedExactHosts,
                usedPslOverrides);

        return JsonSerializer.Serialize(
            metadata,
            new JsonSerializerOptions
            {
                WriteIndented = true
            });
    }

    private static HashSet<string>
        LoadExactHostnames(string path)
    {
        var output = new HashSet<string>(
            StringComparer.OrdinalIgnoreCase);

        if (!File.Exists(path))
        {
            return output;
        }

        foreach (string rawLine in
            File.ReadLines(path))
        {
            string line =
                RemoveBomArtifacts(rawLine)
                    .Trim();

            if (
                line.Length == 0 ||
                line.StartsWith(
                    "#",
                    StringComparison.Ordinal) ||
                line.StartsWith(
                    "!",
                    StringComparison.Ordinal))
            {
                continue;
            }

            string hostname =
                NormalizeHostname(line);

            if (hostname.Length != 0)
            {
                output.Add(hostname);
            }
        }

        return output;
    }

    private static HashSet<string>
        LoadLabels(string path)
    {
        var output = new HashSet<string>(
            StringComparer.OrdinalIgnoreCase);

        if (!File.Exists(path))
        {
            return output;
        }

        foreach (string rawLine in
            File.ReadLines(path))
        {
            string line =
                RemoveBomArtifacts(rawLine)
                    .Trim();

            if (
                line.Length == 0 ||
                line.StartsWith(
                    "#",
                    StringComparison.Ordinal) ||
                line.StartsWith(
                    "!",
                    StringComparison.Ordinal))
            {
                continue;
            }

            string label =
                NormalizeLabel(line);

            if (label.Length != 0)
            {
                output.Add(label);
            }
        }

        return output;
    }

    private static string NormalizeLabel(
        string value)
    {
        string label =
            RemoveBomArtifacts(value)
                .Trim()
                .ToLowerInvariant()
                .Trim('.');

        if (
            label.Length == 0 ||
            label.Length > 63 ||
            label[0] == '-' ||
            label[label.Length - 1] == '-')
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
        string value)
    {
        string hostname =
            RemoveBomArtifacts(value)
                .Trim()
                .ToLowerInvariant()
                .Trim('.');

        if (
            hostname.Length == 0 ||
            hostname.Length > 253 ||
            hostname.IndexOf(':') >= 0 ||
            hostname.IndexOf('.') < 0 ||
            hostname.Contains(".."))
        {
            return "";
        }

        string[] labels =
            hostname.Split('.');

        if (labels.Length < 2)
        {
            return "";
        }

        var idn = new IdnMapping();
        var normalizedLabels =
            new string[labels.Length];

        try
        {
            for (
                int index = 0;
                index < labels.Length;
                index++)
            {
                string label =
                    idn.GetAscii(labels[index])
                        .ToLowerInvariant();

                if (
                    label.Length == 0 ||
                    label.Length > 63 ||
                    label[0] == '-' ||
                    label[label.Length - 1] == '-')
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

                normalizedLabels[index] =
                    label;
            }
        }
        catch
        {
            return "";
        }

        return string.Join(
            ".",
            normalizedLabels);
    }

    private static string[]
        NormalizeCollection(
            IEnumerable<string> values,
            Func<string, string> normalizer)
    {
        var output = new HashSet<string>(
            StringComparer.OrdinalIgnoreCase);

        if (values != null)
        {
            foreach (string value in values)
            {
                string normalized =
                    normalizer(value);

                if (normalized.Length != 0)
                {
                    output.Add(normalized);
                }
            }
        }

        string[] result = output.ToArray();

        Array.Sort(
            result,
            StringComparer.Ordinal);

        return result;
    }

    private static void WriteSortedUnique(
        string path,
        IEnumerable<string> values,
        Func<string, string> normalizer)
    {
        string[] normalized =
            NormalizeCollection(
                values,
                normalizer);

        File.WriteAllLines(
            path,
            normalized,
            new UTF8Encoding(false));
    }

    private static string RemoveBomArtifacts(
        string value)
    {
        string text =
            (value ?? "").TrimStart('\uFEFF');

        while (
            text.StartsWith(
                "\u00EF\u00BB\u00BF",
                StringComparison.Ordinal))
        {
            text = text.Substring(3);
        }

        while (
            text.StartsWith(
                "\u00EF\u00BF\u00BD",
                StringComparison.Ordinal))
        {
            text = text.Substring(3);
        }

        return text;
    }

    private static string ComputeSha256(
        string path)
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
                FileOptions.SequentialScan);

        byte[] hash =
            sha256.ComputeHash(stream);

        var builder =
            new StringBuilder(
                hash.Length * 2);

        foreach (byte value in hash)
        {
            builder.Append(
                value.ToString(
                    "x2",
                    CultureInfo.InvariantCulture));
        }

        return builder.ToString();
    }
}

internal sealed class ApprovedRulesMetadata
{
    public string ApprovedRulesDirectory
    {
        get;
        set;
    } = "";

    public int ApprovedExactHostCount
    {
        get;
        set;
    }

    public int ApprovedPslOverrideCount
    {
        get;
        set;
    }

    public int UsedExactHostCount
    {
        get;
        set;
    }

    public int UsedPslOverrideCount
    {
        get;
        set;
    }

    public string ExactHostSource
    {
        get;
        set;
    } = "";

    public string PslOverrideSource
    {
        get;
        set;
    } = "";

    public string ExactHostSourceSha256
    {
        get;
        set;
    } = "";

    public string PslOverrideSourceSha256
    {
        get;
        set;
    } = "";

    public string[] UsedExactHosts
    {
        get;
        set;
    } = Array.Empty<string>();

    public string[] UsedPslOverrides
    {
        get;
        set;
    } = Array.Empty<string>();
}
