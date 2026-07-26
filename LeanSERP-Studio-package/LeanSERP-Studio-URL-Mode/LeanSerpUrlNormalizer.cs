using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

internal static class Program
{
    private const int MaxHostnameLength = 253;
    private const int MaxLabelLength = 63;
    private const int DefaultChunkSize = 500000;

    private sealed class Options
    {
        public readonly List<string> InputFiles = new List<string>();
        public string OutputDirectory = "";
        public string PublicSuffixList = "";
        public int ChunkSize = DefaultChunkSize;
        public bool KeepUnderscores;
        public bool RemoveCommonWwwLabels;
    }

    private sealed class PslRules
    {
        public readonly HashSet<string> Exact =
            new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        public readonly HashSet<string> Wildcards =
            new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        public readonly HashSet<string> Exceptions =
            new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        public int Count =>
            Exact.Count + Wildcards.Count + Exceptions.Count;
    }

    private sealed class BuildMetadata
    {
        public string Format { get; set; } = "leanserp-compiled-label-package";
        public int Version { get; set; } = 1;
        public string CreatedAt { get; set; } = "";
        public double DurationSeconds { get; set; }
        public long InputLines { get; set; }
        public long AcceptedLines { get; set; }
        public long RejectedLines { get; set; }
        public long PublicSuffixOnlyLines { get; set; }
        public long UniqueLabels { get; set; }
        public long DuplicatesRemoved { get; set; }
        public bool KeepUnderscores { get; set; }
        public bool RemoveCommonWwwLabels { get; set; }
        public int PublicSuffixRuleCount { get; set; }
        public string LabelsSha256 { get; set; } = "";
        public string RejectionsSha256 { get; set; } = "";
        public List<SourceMetadata> Sources { get; set; } =
            new List<SourceMetadata>();
    }

    private sealed class SourceMetadata
    {
        public string Path { get; set; } = "";
        public long ByteLength { get; set; }
        public long Lines { get; set; }
        public long AcceptedLines { get; set; }
        public long RejectedLines { get; set; }
        public string Sha256 { get; set; } = "";
    }

    private readonly struct ParseResult
    {
        public ParseResult(string hostname, string compactLabel, string reason)
        {
            Hostname = hostname;
            CompactLabel = compactLabel;
            Reason = reason;
        }

        public string Hostname { get; }
        public string CompactLabel { get; }
        public string Reason { get; }
    }

    private static int Main(string[] args)
    {
        try
        {
            Options options = ParseOptions(args);
            ValidateOptions(options);

            DateTimeOffset startedAt = DateTimeOffset.UtcNow;
            Directory.CreateDirectory(options.OutputDirectory);

            string timestamp = DateTime.Now.ToString("yyyyMMdd-HHmmss");
            string buildDirectory = Path.Combine(
                options.OutputDirectory,
                "compiled-build-" + timestamp
            );
            string chunkDirectory = Path.Combine(buildDirectory, "chunks");

            Directory.CreateDirectory(buildDirectory);
            Directory.CreateDirectory(chunkDirectory);

            string labelsPath = Path.Combine(buildDirectory, "labels.txt");
            string rejectedPath = Path.Combine(buildDirectory, "rejected-lines.tsv");
            string pslOnlyPath = Path.Combine(
                buildDirectory,
                "public-suffix-only.tsv"
            );
            string metadataPath = Path.Combine(buildDirectory, "metadata.json");

            Console.WriteLine("Loading Public Suffix List...");
            PslRules psl = LoadPublicSuffixList(options.PublicSuffixList);
            Console.WriteLine(
                "Loaded {0:N0} Public Suffix List rules.",
                psl.Count
            );

            var chunk = new HashSet<string>(StringComparer.Ordinal);
            var chunkPaths = new List<string>();
            var sourceReports = new List<SourceMetadata>();
            var idn = new IdnMapping();

            long totalLines = 0;
            long totalAccepted = 0;
            long totalRejected = 0;
            long publicSuffixOnly = 0;
            long duplicateLabels = 0;
            int chunkNumber = 0;

            using (StreamWriter rejectedWriter = NewWriter(rejectedPath))
using (StreamWriter pslOnlyWriter = NewWriter(pslOnlyPath))
{
    rejectedWriter.WriteLine("reason\tsource\tline\toriginal");
    pslOnlyWriter.WriteLine("hostname\tpublicSuffix\tsource\tline");

    foreach (string inputPath in options.InputFiles)
            {
                Console.WriteLine("Reading: " + inputPath);

                long sourceLines = 0;
                long sourceAccepted = 0;
                long sourceRejected = 0;

                using var reader = new StreamReader(
                    inputPath,
                    new UTF8Encoding(false, false),
                    true,
                    1024 * 1024
                );

                string? line;

                while ((line = reader.ReadLine()) != null)
                {
                    sourceLines++;
                    totalLines++;

                    ParseResult parsed = ParseInput(
                        line,
                        options.KeepUnderscores,
                        idn
                    );

                    string label = "";

                    if (parsed.CompactLabel.Length != 0)
                    {
                        label = parsed.CompactLabel;
                    }
                    else if (parsed.Hostname.Length != 0)
                    {
                        string hostname = options.RemoveCommonWwwLabels
                            ? RemoveLeadingWwwLabels(parsed.Hostname)
                            : parsed.Hostname;

                        int suffixLength = GetPublicSuffixLength(hostname, psl);
                        string[] labels = hostname.Split('.');

                        if (suffixLength >= labels.Length)
                        {
                            publicSuffixOnly++;
                            totalRejected++;
                            sourceRejected++;

                            pslOnlyWriter.WriteLine(
                                EscapeField(hostname) + "\t" +
                                EscapeField(string.Join(
                                    ".",
                                    labels.Skip(
                                        Math.Max(0, labels.Length - suffixLength)
                                    )
                                )) + "\t" +
                                EscapeField(inputPath) + "\t" +
                                sourceLines.ToString(CultureInfo.InvariantCulture)
                            );

                            rejectedWriter.WriteLine(
                                "public-suffix-only\t" +
                                EscapeField(inputPath) + "\t" +
                                sourceLines.ToString(CultureInfo.InvariantCulture) +
                                "\t" +
                                EscapeField(line)
                            );

                            continue;
                        }

                        int mainLabelIndex = labels.Length - suffixLength - 1;

                        if (mainLabelIndex < 0)
                        {
                            totalRejected++;
                            sourceRejected++;

                            rejectedWriter.WriteLine(
                                "main-label-not-found\t" +
                                EscapeField(inputPath) + "\t" +
                                sourceLines.ToString(CultureInfo.InvariantCulture) +
                                "\t" +
                                EscapeField(line)
                            );

                            continue;
                        }

                        label = labels[mainLabelIndex];
                    }
                    else
                    {
                        totalRejected++;
                        sourceRejected++;

                        rejectedWriter.WriteLine(
                            EscapeField(parsed.Reason) + "\t" +
                            EscapeField(inputPath) + "\t" +
                            sourceLines.ToString(CultureInfo.InvariantCulture) +
                            "\t" +
                            EscapeField(line)
                        );

                        continue;
                    }

                    if (chunk.Add(label))
                    {
                        totalAccepted++;
                        sourceAccepted++;
                    }
                    else
                    {
                        duplicateLabels++;
                        totalAccepted++;
                        sourceAccepted++;
                    }

                    if (chunk.Count >= options.ChunkSize)
                    {
                        chunkNumber++;
                        string chunkPath = WriteChunk(
                            chunk,
                            chunkDirectory,
                            chunkNumber
                        );
                        chunkPaths.Add(chunkPath);
                        chunk.Clear();

                        Console.WriteLine(
                            "Created chunk {0}; processed {1:N0} lines.",
                            chunkNumber,
                            totalLines
                        );
                    }

                    if (totalLines % 1_000_000 == 0)
                    {
                        Console.WriteLine(
                            "Processed {0:N0} lines.",
                            totalLines
                        );
                    }
                }

                sourceReports.Add(new SourceMetadata
                {
                    Path = Path.GetFullPath(inputPath),
                    ByteLength = new FileInfo(inputPath).Length,
                    Lines = sourceLines,
                    AcceptedLines = sourceAccepted,
                    RejectedLines = sourceRejected,
                    Sha256 = ComputeSha256(inputPath)
                });
            }
}

            if (chunk.Count > 0)
            {
                chunkNumber++;
                string chunkPath = WriteChunk(
                    chunk,
                    chunkDirectory,
                    chunkNumber
                );
                chunkPaths.Add(chunkPath);
                chunk.Clear();
            }

            if (chunkPaths.Count == 0)
            {
                throw new InvalidOperationException(
                    "No valid labels were produced."
                );
            }

            Console.WriteLine(
                "Merging {0:N0} sorted chunks...",
                chunkPaths.Count
            );

            (long uniqueLabels, long mergeDuplicates) = MergeChunks(
                chunkPaths,
                labelsPath
            );

            duplicateLabels += mergeDuplicates;

            DateTimeOffset finishedAt = DateTimeOffset.UtcNow;

            var metadata = new BuildMetadata
            {
                CreatedAt = finishedAt.ToString("O"),
                DurationSeconds = Math.Round(
                    (finishedAt - startedAt).TotalSeconds,
                    3
                ),
                InputLines = totalLines,
                AcceptedLines = totalAccepted,
                RejectedLines = totalRejected,
                PublicSuffixOnlyLines = publicSuffixOnly,
                UniqueLabels = uniqueLabels,
                DuplicatesRemoved = duplicateLabels,
                KeepUnderscores = options.KeepUnderscores,
                RemoveCommonWwwLabels = options.RemoveCommonWwwLabels,
                PublicSuffixRuleCount = psl.Count,
                LabelsSha256 = ComputeSha256(labelsPath),
                RejectionsSha256 = ComputeSha256(rejectedPath),
                Sources = sourceReports
            };

            string metadataJson = JsonSerializer.Serialize(
                metadata,
                new JsonSerializerOptions
                {
                    WriteIndented = true
                }
            );

            File.WriteAllText(
                metadataPath,
                metadataJson + Environment.NewLine,
                new UTF8Encoding(false)
            );

            Directory.Delete(chunkDirectory, true);

            Console.WriteLine();
            Console.WriteLine("LeanSERP compiled build completed.");
            Console.WriteLine("Input lines: {0:N0}", totalLines);
            Console.WriteLine("Accepted lines: {0:N0}", totalAccepted);
            Console.WriteLine("Rejected lines: {0:N0}", totalRejected);
            Console.WriteLine("Public-suffix-only lines: {0:N0}", publicSuffixOnly);
            Console.WriteLine("Unique labels: {0:N0}", uniqueLabels);
            Console.WriteLine("Duplicates removed: {0:N0}", duplicateLabels);
            Console.WriteLine("Package:");
            Console.WriteLine(buildDirectory);
            Console.WriteLine("Metadata:");
            Console.WriteLine(metadataPath);
            Console.WriteLine("Labels SHA-256:");
            Console.WriteLine(metadata.LabelsSha256);

            return 0;
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine("BUILD ERROR");
            Console.Error.WriteLine(exception);
            return 1;
        }
    }

    private static Options ParseOptions(string[] args)
    {
        var options = new Options();

        for (int index = 0; index < args.Length; index++)
        {
            string argument = args[index];

            switch (argument.ToLowerInvariant())
            {
                case "--input":
                case "-input":
                    options.InputFiles.Add(RequireValue(args, ref index));
                    break;

                case "--output":
                case "-output":
                    options.OutputDirectory = RequireValue(args, ref index);
                    break;

                case "--psl":
                case "-psl":
                    options.PublicSuffixList = RequireValue(args, ref index);
                    break;

                case "--chunk-size":
                case "-chunksize":
                    options.ChunkSize = int.Parse(
                        RequireValue(args, ref index),
                        CultureInfo.InvariantCulture
                    );
                    break;

                case "--keep-underscores":
                    options.KeepUnderscores = true;
                    break;

                case "--remove-www":
                    options.RemoveCommonWwwLabels = true;
                    break;

                default:
                    throw new ArgumentException(
                        "Unknown argument: " + argument
                    );
            }
        }

        return options;
    }

    private static string RequireValue(string[] args, ref int index)
    {
        index++;

        if (index >= args.Length)
        {
            throw new ArgumentException(
                "A command-line option is missing its value."
            );
        }

        return args[index];
    }

    private static void ValidateOptions(Options options)
    {
        if (options.InputFiles.Count == 0)
        {
            throw new ArgumentException("No input files were supplied.");
        }

        foreach (string path in options.InputFiles)
        {
            if (!File.Exists(path))
            {
                throw new FileNotFoundException(
                    "Input file was not found.",
                    path
                );
            }
        }

        if (string.IsNullOrWhiteSpace(options.OutputDirectory))
        {
            throw new ArgumentException(
                "The output directory is missing."
            );
        }

        if (!File.Exists(options.PublicSuffixList))
        {
            throw new FileNotFoundException(
                "The Public Suffix List was not found.",
                options.PublicSuffixList
            );
        }

        if (options.ChunkSize < 1000 || options.ChunkSize > 1_000_000)
        {
            throw new ArgumentOutOfRangeException(
                nameof(options.ChunkSize)
            );
        }
    }

    private static PslRules LoadPublicSuffixList(string path)
    {
        var rules = new PslRules();

        foreach (string rawLine in File.ReadLines(path))
        {
            string line = rawLine.Trim();

            if (line.Length == 0 || line.StartsWith("//"))
            {
                continue;
            }

            int inlineComment = line.IndexOf(
                " //",
                StringComparison.Ordinal
            );

            if (inlineComment >= 0)
            {
                line = line.Substring(0, inlineComment).Trim();
            }

            if (line.Length == 0)
            {
                continue;
            }

            line = line.ToLowerInvariant();

            if (line.StartsWith("!"))
            {
                rules.Exceptions.Add(line.Substring(1));
            }
            else if (line.StartsWith("*."))
            {
                rules.Wildcards.Add(line.Substring(2));
            }
            else
            {
                rules.Exact.Add(line);
            }
        }

        if (
            rules.Count < 1000 ||
            !rules.Exact.Contains("com") ||
            !rules.Exact.Contains("co.uk") ||
            !rules.Wildcards.Contains("ck") ||
            !rules.Exceptions.Contains("www.ck")
        )
        {
            throw new InvalidDataException(
                "The Public Suffix List failed validation."
            );
        }

        return rules;
    }

    private static ParseResult ParseInput(
        string rawLine,
        bool keepUnderscores,
        IdnMapping idn
    )
    {
        string text = RemoveBomArtifacts(rawLine).Trim();

        if (
            text.Length == 0 ||
            text.StartsWith("#") ||
            text.StartsWith("!")
        )
        {
            return new ParseResult(
                "",
                "",
                "empty-comment-or-directive"
            );
        }

        if (text.IndexOf('\0') >= 0)
        {
            return new ParseResult("", "", "nul-character");
        }

        string[] fields = Regex.Split(text, @"\s+");

        if (
            fields.Length >= 2 &&
            Regex.IsMatch(
                fields[0],
                @"^(?:0\.0\.0\.0|127\.0\.0\.1|::1)$"
            )
        )
        {
            text = fields[1];
        }
        else
        {
            text = fields[0];
        }

        if (text.StartsWith("@@"))
        {
            return new ParseResult("", "", "exception-rule");
        }

        text = text.ToLowerInvariant();

        Match markdown = Regex.Match(
            text,
            @"^\[[^\]]*\]\((https?://[^)]+)\)$",
            RegexOptions.IgnoreCase
        );

        if (markdown.Success)
        {
            text = markdown.Groups[1].Value;
        }

        if (text.StartsWith("*://*."))
        {
            text = text.Substring(6);
        }
        else if (text.StartsWith("*://"))
        {
            text = text.Substring(4);

            if (text.StartsWith("*."))
            {
                text = text.Substring(2);
            }
        }
        else if (Regex.IsMatch(text, @"^[a-z][a-z0-9+.-]*://"))
        {
            if (!Uri.TryCreate(text, UriKind.Absolute, out Uri? uri))
            {
                return new ParseResult("", "", "invalid-url");
            }

            text = uri.DnsSafeHost;
        }

        text = RemoveBomArtifacts(text);

        int separator = text.IndexOfAny(new[] { '/', '?', '#' });

        if (separator >= 0)
        {
            text = text.Substring(0, separator);
        }

        int atIndex = text.LastIndexOf('@');

        if (atIndex >= 0)
        {
            text = text.Substring(atIndex + 1);
        }

        text = Regex.Replace(text, @":\d+$", "");
        text = text.Trim('.');

        string labelPattern = keepUnderscores
            ? @"^[a-z0-9_-]{1,63}$"
            : @"^[a-z0-9-]{1,63}$";

        if (Regex.IsMatch(text, labelPattern))
        {
            return new ParseResult("", text, "");
        }

        if (
            text.Length == 0 ||
            text.Length > MaxHostnameLength ||
            text.Contains(':') ||
            !text.Contains('.')
        )
        {
            return new ParseResult("", "", "invalid-hostname");
        }

        var asciiLabels = new List<string>();

        try
        {
            foreach (string sourceLabel in text.Split('.'))
            {
                if (sourceLabel.Length == 0)
                {
                    return new ParseResult(
                        "",
                        "",
                        "empty-hostname-label"
                    );
                }

                string label = idn.GetAscii(sourceLabel).ToLowerInvariant();

                if (
                    label.Length == 0 ||
                    label.Length > MaxLabelLength ||
                    !Regex.IsMatch(
                        label,
                        keepUnderscores
                            ? @"^[a-z0-9_-]+$"
                            : @"^[a-z0-9-]+$"
                    ) ||
                    label.StartsWith("-") ||
                    label.EndsWith("-")
                )
                {
                    return new ParseResult(
                        "",
                        "",
                        "invalid-hostname-label"
                    );
                }

                asciiLabels.Add(label);
            }
        }
        catch
        {
            return new ParseResult("", "", "idn-conversion-failed");
        }

        return new ParseResult(
            string.Join(".", asciiLabels),
            "",
            ""
        );
    }

    private static string RemoveBomArtifacts(string value)
    {
        string text = value.TrimStart('\uFEFF');

        while (text.StartsWith("\u00EF\u00BB\u00BF"))
        {
            text = text.Substring(3);
        }

        while (text.StartsWith("\u00EF\u00BF\u00BD"))
        {
            text = text.Substring(3);
        }

        return text;
    }

    private static string RemoveLeadingWwwLabels(string hostname)
    {
        var labels = new List<string>(hostname.Split('.'));

        while (
            labels.Count > 2 &&
            Regex.IsMatch(labels[0], @"^www\d*$")
        )
        {
            labels.RemoveAt(0);
        }

        return string.Join(".", labels);
    }

    private static int GetPublicSuffixLength(
        string hostname,
        PslRules rules
    )
    {
        string[] labels = hostname.Split('.');

        if (labels.Length < 2)
        {
            return 1;
        }

        int bestLength = 1;
        string candidate = "";

        for (int index = labels.Length - 1; index >= 0; index--)
        {
            candidate = candidate.Length == 0
                ? labels[index]
                : labels[index] + "." + candidate;

            int candidateLength = labels.Length - index;

            if (rules.Exceptions.Contains(candidate))
            {
                return Math.Max(1, candidateLength - 1);
            }

            if (
                rules.Exact.Contains(candidate) &&
                candidateLength > bestLength
            )
            {
                bestLength = candidateLength;
            }

                        if (index < labels.Length - 1)
            {
                int firstDot = candidate.IndexOf('.');
                if (firstDot >= 0)
                {
                    string wildcardBase =
                        candidate.Substring(firstDot + 1);

                    if (
                        rules.Wildcards.Contains(wildcardBase) &&
                        candidateLength > bestLength
                    )
                    {
                        bestLength = candidateLength;
                    }
                }
            }
        }

        return Math.Min(bestLength, labels.Length);
    }

    private static string WriteChunk(
        HashSet<string> values,
        string directory,
        int number
    )
    {
        string path = Path.Combine(
            directory,
            "labels-" +
            number.ToString(
                "D6",
                CultureInfo.InvariantCulture
            ) +
            ".txt"
        );

        string[] sorted = values.ToArray();
        Array.Sort(sorted, StringComparer.Ordinal);

        using var writer = NewWriter(path);

        foreach (string value in sorted)
        {
            writer.WriteLine(value);
        }

        return path;
    }

    private sealed class MergeItem
    {
        public string Value { get; set; } = "";
        public int ReaderIndex { get; set; }
    }

    private sealed class MergeItemComparer :
        IComparer<MergeItem>
    {
        public int Compare(
            MergeItem? left,
            MergeItem? right
        )
        {
            if (ReferenceEquals(left, right))
            {
                return 0;
            }

            if (left is null)
            {
                return -1;
            }

            if (right is null)
            {
                return 1;
            }

            int valueComparison =
                string.CompareOrdinal(
                    left.Value,
                    right.Value
                );

            if (valueComparison != 0)
            {
                return valueComparison;
            }

            return left.ReaderIndex.CompareTo(
                right.ReaderIndex
            );
        }
    }

    private static (
        long UniqueLabels,
        long DuplicateLabels
    ) MergeChunks(
        IReadOnlyList<string> chunkPaths,
        string outputPath
    )
    {
        var readers =
            new List<StreamReader>(
                chunkPaths.Count
            );

        var queue =
            new SortedSet<MergeItem>(
                new MergeItemComparer()
            );

        long uniqueLabels = 0;
        long duplicateLabels = 0;
        string? lastWritten = null;

        using var writer = NewWriter(outputPath);

        try
        {
            for (
                int index = 0;
                index < chunkPaths.Count;
                index++
            )
            {
                var reader = new StreamReader(
                    chunkPaths[index],
                    new UTF8Encoding(
                        false,
                        false
                    ),
                    true,
                    1024 * 1024
                );

                readers.Add(reader);

                string? value =
                    reader.ReadLine();

                if (value != null)
                {
                    queue.Add(
                        new MergeItem
                        {
                            Value = value,
                            ReaderIndex = index
                        }
                    );
                }
            }

            while (queue.Count > 0)
            {
                MergeItem item = queue.Min!;
                queue.Remove(item);

                if (
                    lastWritten == null ||
                    !string.Equals(
                        item.Value,
                        lastWritten,
                        StringComparison.Ordinal
                    )
                )
                {
                    writer.WriteLine(item.Value);
                    lastWritten = item.Value;
                    uniqueLabels++;
                }
                else
                {
                    duplicateLabels++;
                }

                string? nextValue =
                    readers[
                        item.ReaderIndex
                    ].ReadLine();

                if (nextValue != null)
                {
                    queue.Add(
                        new MergeItem
                        {
                            Value = nextValue,
                            ReaderIndex =
                                item.ReaderIndex
                        }
                    );
                }
            }
        }
        finally
        {
            foreach (
                StreamReader reader in readers
            )
            {
                reader.Dispose();
            }
        }

        return (
            uniqueLabels,
            duplicateLabels
        );
    }

    private static StreamWriter NewWriter(
        string path
    )
    {
        return new StreamWriter(
            path,
            false,
            new UTF8Encoding(false),
            1024 * 1024
        );
    }

    private static string EscapeField(
        string value
    )
    {
        return value
            .Replace('\t', ' ')
            .Replace('\r', ' ')
            .Replace('\n', ' ');
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

        var builder =
            new StringBuilder(
                hash.Length * 2
            );

        foreach (byte value in hash)
        {
            builder.Append(
                value.ToString(
                    "x2",
                    CultureInfo.InvariantCulture
                )
            );
        }

        return builder.ToString();
    }
}

