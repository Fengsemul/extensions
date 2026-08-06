"use strict";
(() => {
    const LeanDb = globalThis.LeanDb;
    if (!LeanDb) {
        throw new Error(
            "database.js did not initialize LeanDb."
        );
    }

    const PRODUCTION_BATCH_SIZE = 4000;
    const MANUAL_BATCH_SIZE = 4000;
    const MAX_LABEL_LENGTH = 63;
    const MAX_HOSTNAME_LENGTH = 253;

    const RULE_FILES = Object.freeze({
        labels: Object.freeze({
            inputId: "production-labels-file",
            outputId: "production-labels-selection",
            ruleType: LeanDb.RULE_TYPES.label
        }),
        exactHosts: Object.freeze({
            inputId: "production-exact-file",
            outputId: "production-exact-selection",
            ruleType: LeanDb.RULE_TYPES.exactHost
        }),
        pslOverrides: Object.freeze({
            inputId: "production-overrides-file",
            outputId: "production-overrides-selection",
            ruleType: LeanDb.RULE_TYPES.pslOverride
        })
    });

    const CATEGORY_NAMES = Object.freeze({
        labels: "Blocked labels",
        exactHosts: "Exact blocked hosts",
        pslOverrides: "Approved PSL overrides"
    });

    const elements = Object.freeze({
        refreshStatus:
            document.getElementById(
                "refresh-status"
            ),
        productionLabelCount:
            document.getElementById(
                "production-label-count"
            ),
        productionExactCount:
            document.getElementById(
                "production-exact-count"
            ),
        productionOverrideCount:
            document.getElementById(
                "production-override-count"
            ),
        manualLabelCount:
            document.getElementById(
                "manual-label-count"
            ),
        manualExactCount:
            document.getElementById(
                "manual-exact-count"
            ),
        manualOverrideCount:
            document.getElementById(
                "manual-override-count"
            ),
        activeSlot:
            document.getElementById(
                "active-slot"
            ),
        stagingSlot:
            document.getElementById(
                "staging-slot"
            ),
        productionPackageName:
            document.getElementById(
                "production-package-name"
            ),
        importProduction:
            document.getElementById(
                "import-production"
            ),
        productionProgress:
            document.getElementById(
                "production-progress"
            ),
        productionStatus:
            document.getElementById(
                "production-status"
            ),
        packageRows:
            document.getElementById(
                "package-rows"
            ),
        manualCategory:
            document.getElementById(
                "manual-category"
            ),
        manualFile:
            document.getElementById(
                "manual-file"
            ),
        manualFileSelection:
            document.getElementById(
                "manual-file-selection"
            ),
        importManual:
            document.getElementById(
                "import-manual"
            ),
        manualProgress:
            document.getElementById(
                "manual-progress"
            ),
        manualStatus:
            document.getElementById(
                "manual-status"
            ),
        manualImportRows:
            document.getElementById(
                "manual-import-rows"
            ),
        diagnosticsTab:
            document.getElementById(
                "diagnostics-tab"
            ),
        refreshDiagnosticsTabs:
            document.getElementById(
                "refresh-diagnostics-tabs"
            ),
        collectDiagnostics:
            document.getElementById(
                "collect-diagnostics"
            ),
        diagnosticsOutput:
            document.getElementById(
                "diagnostics-output"
            ),
        proposeAdapter:
            document.getElementById(
                "propose-adapter"
            ),
        previewAdapter:
            document.getElementById(
                "preview-adapter"
            ),
        clearAdapterPreview:
            document.getElementById(
                "clear-adapter-preview"
            ),
        adapterStatus:
            document.getElementById(
                "adapter-status"
            ),
        adapterOutput:
            document.getElementById(
                "adapter-output"
            ),
        saveAdapter:
            document.getElementById(
                "save-adapter"
            ),
        clearCaches:
            document.getElementById(
                "clear-caches"
            ),
        deleteDatabase:
            document.getElementById(
                "delete-database"
            ),
        actionStatus:
            document.getElementById(
                "action-status"
            )
    });

    let operationRunning = false;
    let proposedAdapter = null;
    let adapterPreviewActive = false;

    function assertElements() {
        for (
            const [name, element] of
            Object.entries(elements)
        ) {
            if (!element) {
                throw new Error(
                    `manager.html is missing element: ${name}`
                );
            }
        }
    }

    function formatCount(value) {
        return Number(value || 0)
            .toLocaleString();
    }

    function formatSize(value) {
        const bytes = Number(value || 0);
        if (bytes < 1024) {
            return `${bytes} B`;
        }
        if (bytes < 1024 * 1024) {
            return (
                bytes / 1024
            ).toFixed(1) + " KiB";
        }
        if (bytes < 1024 * 1024 * 1024) {
            return (
                bytes /
                (1024 * 1024)
            ).toFixed(1) + " MiB";
        }
        return (
            bytes /
            (1024 * 1024 * 1024)
        ).toFixed(2) + " GiB";
    }

    function formatDate(value) {
        if (!value) {
            return "";
        }
        const date = new Date(value);
        return Number.isNaN(date.getTime())
            ? String(value)
            : date.toLocaleString();
    }

    function getErrorMessage(error) {
        return error && error.message
            ? error.message
            : String(error);
    }

    function setStatus(
        element,
        message,
        state = ""
    ) {
        element.textContent = message;
        if (state) {
            element.dataset.state = state;
        } else {
            delete element.dataset.state;
        }
    }

    function createCell(
        row,
        text,
        className = ""
    ) {
        const cell =
            document.createElement("td");
        cell.textContent =
            String(text ?? "");
        if (className) {
            cell.className = className;
        }
        row.appendChild(cell);
        return cell;
    }

    function createActionCell(row) {
        const cell =
            document.createElement("td");
        row.appendChild(cell);
        return cell;
    }

    function getProductionInput(name) {
        return document.getElementById(
            RULE_FILES[name].inputId
        );
    }

    function getProductionSelection(name) {
        return document.getElementById(
            RULE_FILES[name].outputId
        );
    }

    function describeFile(file) {
        return file
            ? `${file.name} (${formatSize(file.size)})`
            : "No file selected.";
    }

    function normalizeLabel(value) {
        const label = String(value || "")
            .replace(/^\uFEFF/, "")
            .trim()
            .toLowerCase()
            .replace(/^\.+|\.+$/g, "");

        if (
            label.length === 0 ||
            label.length > MAX_LABEL_LENGTH ||
            !/^[a-z0-9_-]+$/.test(label) ||
            label.startsWith("-") ||
            label.endsWith("-")
        ) {
            return "";
        }

        return label;
    }

    function normalizeHostname(value) {
        const hostname = String(value || "")
            .replace(/^\uFEFF/, "")
            .trim()
            .toLowerCase()
            .replace(/^\.+|\.+$/g, "");

        if (
            hostname.length === 0 ||
            hostname.length >
                MAX_HOSTNAME_LENGTH ||
            !hostname.includes(".") ||
            hostname.includes(":") ||
            hostname.includes("..")
        ) {
            return "";
        }

        const labels = hostname.split(".");
        for (const label of labels) {
            if (
                label.length === 0 ||
                label.length >
                    MAX_LABEL_LENGTH ||
                !/^[a-z0-9_-]+$/.test(
                    label
                ) ||
                label.startsWith("-") ||
                label.endsWith("-")
            ) {
                return "";
            }
        }

        return labels.join(".");
    }

    function normalizeRule(
        value,
        category
    ) {
        return category === "exactHosts"
            ? normalizeHostname(value)
            : normalizeLabel(value);
    }

    async function* readLines(file) {
        const reader =
            file.stream().getReader();
        const decoder =
            new TextDecoder(
                "utf-8",
                {
                    fatal: false,
                    ignoreBOM: false
                }
            );

        let remainder = "";
        let bytesRead = 0;

        try {
            while (true) {
                const record =
                    await reader.read();

                if (record.done) {
                    break;
                }

                bytesRead +=
                    record.value.byteLength;

                remainder += decoder.decode(
                    record.value,
                    {
                        stream: true
                    }
                );

                const lines =
                    remainder.split(/\r?\n/);
                remainder =
                    lines.pop() || "";

                for (const line of lines) {
                    yield {
                        line,
                        bytesRead
                    };
                }
            }

            remainder += decoder.decode();

            if (remainder.length > 0) {
                yield {
                    line: remainder,
                    bytesRead
                };
            }
        } finally {
            reader.releaseLock();
        }
    }

    async function countValidRules(
        file,
        category
    ) {
        let valid = 0;
        let rejected = 0;

        for await (
            const record of readLines(file)
        ) {
            const rawLine =
                String(record.line || "");

            if (
                rawLine.length === 0 ||
                rawLine.trim().startsWith("#")
            ) {
                rejected += 1;
                continue;
            }

            if (
                normalizeRule(
                    rawLine,
                    category
                )
            ) {
                valid += 1;
            } else {
                rejected += 1;
            }
        }

        return {
            valid,
            rejected
        };
    }

    function updateAdapterButtons() {
        const hasProposal =
            proposedAdapter !== null;

        elements.proposeAdapter.disabled =
            operationRunning;

        elements.previewAdapter.disabled =
            operationRunning ||
            !hasProposal;

        elements.clearAdapterPreview.disabled =
            operationRunning ||
            !adapterPreviewActive;

        elements.saveAdapter.disabled =
            operationRunning ||
            !hasProposal;
    }

    function setOperationRunning(running) {
        operationRunning = running;

        elements.refreshStatus.disabled =
            running;
        elements.importProduction.disabled =
            running;
        elements.importManual.disabled =
            running;
        elements.manualCategory.disabled =
            running;
        elements.manualFile.disabled =
            running;
        elements.productionPackageName.disabled =
            running;
        elements.deleteDatabase.disabled =
            running;
        elements.clearCaches.disabled =
            running;
        elements.diagnosticsTab.disabled =
            running;
        elements.refreshDiagnosticsTabs.disabled =
            running;
        elements.collectDiagnostics.disabled =
            running;

        for (
            const name of
            Object.keys(RULE_FILES)
        ) {
            getProductionInput(name).disabled =
                running;
        }

        for (
            const button of
            document.querySelectorAll(
                "[data-slot-delete], " +
                "[data-manual-import-delete]"
            )
        ) {
            button.disabled = running;
        }

        updateAdapterButtons();
    }

    async function send(message) {
        const response =
            await browser.runtime.sendMessage(
                message
            );

        if (!response || !response.ok) {
            throw new Error(
                response && response.error
                    ? response.error
                    : "The background operation failed."
            );
        }

        return response;
    }

    function renderPackages(records) {
        elements.packageRows
            .replaceChildren();

        if (records.length === 0) {
            const row =
                document.createElement("tr");
            const cell = createCell(
                row,
                "No production packages."
            );
            cell.colSpan = 8;
            elements.packageRows
                .appendChild(row);
            return;
        }

        for (const record of records) {
            const row =
                document.createElement("tr");

            createCell(
                row,
                record.slot
            );
            createCell(
                row,
                record.packageName ||
                    "(unnamed)"
            );
            createCell(
                row,
                record.state || "",
                `state-${record.state || ""}`
            );
            createCell(
                row,
                formatCount(
                    record.importedCounts
                        ?.labels
                ),
                "numeric"
            );
            createCell(
                row,
                formatCount(
                    record.importedCounts
                        ?.exactHosts
                ),
                "numeric"
            );
            createCell(
                row,
                formatCount(
                    record.importedCounts
                        ?.pslOverrides
                ),
                "numeric"
            );
            createCell(
                row,
                formatDate(
                    record.createdAt
                )
            );

            const actionCell =
                createActionCell(row);

            if (record.state !== "active") {
                const button =
                    document.createElement(
                        "button"
                    );
                button.type = "button";
                button.textContent = "Delete";
                button.className = "danger";
                button.dataset.slotDelete =
                    record.slot;
                button.addEventListener(
                    "click",
                    () => {
                        void deleteProductionSlot(
                            record.slot
                        );
                    }
                );
                actionCell.appendChild(button);
            } else {
                actionCell.textContent =
                    "Active";
            }

            elements.packageRows
                .appendChild(row);
        }
    }

    function renderManualImports(records) {
        elements.manualImportRows
            .replaceChildren();

        if (records.length === 0) {
            const row =
                document.createElement("tr");
            const cell = createCell(
                row,
                "No manual imports."
            );
            cell.colSpan = 9;
            elements.manualImportRows
                .appendChild(row);
            return;
        }

        for (const record of records) {
            const row =
                document.createElement("tr");

            createCell(
                row,
                record.fileName ||
                    "(unnamed)"
            );
            createCell(
                row,
                CATEGORY_NAMES[
                    record.category
                ] || record.category
            );
            createCell(
                row,
                record.state || ""
            );
            createCell(
                row,
                formatCount(
                    record.validRules
                ),
                "numeric"
            );
            createCell(
                row,
                formatCount(
                    record.uniqueRules
                ),
                "numeric"
            );
            createCell(
                row,
                formatCount(
                    record.rejectedRules
                ),
                "numeric"
            );
            createCell(
                row,
                formatSize(
                    record.fileSize
                ),
                "numeric"
            );
            createCell(
                row,
                formatDate(
                    record.importedAt
                )
            );

            const actionCell =
                createActionCell(row);
            const button =
                document.createElement("button");

            button.type = "button";
            button.textContent = "Remove";
            button.className = "danger";
            button.dataset.manualImportDelete =
                record.importId;

            button.addEventListener(
                "click",
                () => {
                    void removeManualImport(
                        record
                    );
                }
            );

            actionCell.appendChild(button);
            elements.manualImportRows
                .appendChild(row);
        }
    }

    async function refreshStatus() {
        const response =
            await send({
                type: "databaseStatus"
            });

        const status = response.status;
        const production =
            status.counts.production;
        const manual =
            status.counts.manual;

        elements.productionLabelCount
            .textContent =
            formatCount(
                production.labels
            );

        elements.productionExactCount
            .textContent =
            formatCount(
                production.exactHosts
            );

        elements.productionOverrideCount
            .textContent =
            formatCount(
                production.pslOverrides
            );

        elements.manualLabelCount
            .textContent =
            formatCount(
                manual.labels
            );

        elements.manualExactCount
            .textContent =
            formatCount(
                manual.exactHosts
            );

        elements.manualOverrideCount
            .textContent =
            formatCount(
                manual.pslOverrides
            );

        elements.activeSlot.textContent =
            status.counts.activeSlot === null
                ? "None"
                : status.counts.activeSlot;

        elements.stagingSlot.textContent =
            status.stagingSlot === null
                ? "None"
                : status.stagingSlot;

        renderPackages(
            status.packages || []
        );

        renderManualImports(
            status.manualImports || []
        );
    }

    function updateProductionSelections() {
        for (
            const name of
            Object.keys(RULE_FILES)
        ) {
            const input =
                getProductionInput(name);
            const output =
                getProductionSelection(name);

            output.textContent =
                describeFile(
                    input.files[0] || null
                );
        }
    }

    function updateManualSelection() {
        elements.manualFileSelection
            .textContent =
            describeFile(
                elements.manualFile
                    .files[0] || null
            );
    }

    async function importProductionFile(
        slot,
        category,
        file,
        progressStart,
        progressShare
    ) {
        const ruleType =
            RULE_FILES[category].ruleType;

        let valid = 0;
        let rejected = 0;
        let batch = [];

        for await (
            const record of readLines(file)
        ) {
            const rawLine =
                String(record.line || "");

            if (
                rawLine.length === 0 ||
                rawLine.trim().startsWith("#")
            ) {
                rejected += 1;
                continue;
            }

            const normalized =
                normalizeRule(
                    rawLine,
                    category
                );

            if (!normalized) {
                rejected += 1;
                continue;
            }

            batch.push(normalized);
            valid += 1;

            if (
                batch.length >=
                PRODUCTION_BATCH_SIZE
            ) {
                await send({
                    type: "putProductionBatch",
                    slot,
                    ruleType,
                    rules: batch
                });

                batch = [];

                const fileFraction =
                    file.size > 0
                        ? record.bytesRead /
                            file.size
                        : 0;

                elements.productionProgress.value =
                    Math.min(
                        99,
                        Math.floor(
                            progressStart +
                            fileFraction *
                                progressShare
                        )
                    );

                setStatus(
                    elements.productionStatus,
                    `Importing ${file.name}: ` +
                        `${valid.toLocaleString()} accepted, ` +
                        `${rejected.toLocaleString()} rejected.`
                );
            }
        }

        if (batch.length > 0) {
            await send({
                type: "putProductionBatch",
                slot,
                ruleType,
                rules: batch
            });
        }

        return {
            valid,
            rejected
        };
    }

    async function importProductionPackage() {
        if (operationRunning) {
            return;
        }

        const selected = {};

        for (
            const name of
            Object.keys(RULE_FILES)
        ) {
            const file =
                getProductionInput(name)
                    .files[0];

            if (!file) {
                setStatus(
                    elements.productionStatus,
                    `Select the ${name} production file.`,
                    "error"
                );
                return;
            }

            selected[name] = file;
        }

        const packageName =
            elements.productionPackageName
                .value
                .trim() ||
            `package-${new Date()
                .toISOString()
                .replace(/[:.]/g, "-")}`;

        setOperationRunning(true);
        elements.productionProgress.value = 0;

        setStatus(
            elements.productionStatus,
            "Counting and validating production files..."
        );

        let slot = null;

        try {
            const countResults = {};

            for (
                const name of
                Object.keys(RULE_FILES)
            ) {
                countResults[name] =
                    await countValidRules(
                        selected[name],
                        name
                    );
            }

            const metadata = {
                packageName,
                expectedCounts: {
                    labels:
                        countResults.labels.valid,
                    exactHosts:
                        countResults
                            .exactHosts.valid,
                    pslOverrides:
                        countResults
                            .pslOverrides.valid
                },
                files: {
                    labels: {
                        name:
                            selected.labels.name,
                        size:
                            selected.labels.size,
                        rejected:
                            countResults.labels
                                .rejected
                    },
                    exactHosts: {
                        name:
                            selected
                                .exactHosts.name,
                        size:
                            selected
                                .exactHosts.size,
                        rejected:
                            countResults
                                .exactHosts
                                .rejected
                    },
                    pslOverrides: {
                        name:
                            selected
                                .pslOverrides.name,
                        size:
                            selected
                                .pslOverrides.size,
                        rejected:
                            countResults
                                .pslOverrides
                                .rejected
                    }
                }
            };

            const beginResponse =
                await send({
                    type:
                        "beginProductionImport",
                    metadata
                });

            slot = beginResponse.slot;

            const categories =
                Object.keys(RULE_FILES);

            const progressShare =
                100 / categories.length;

            for (
                let index = 0;
                index < categories.length;
                index += 1
            ) {
                const category =
                    categories[index];

                await importProductionFile(
                    slot,
                    category,
                    selected[category],
                    index * progressShare,
                    progressShare
                );
            }

            setStatus(
                elements.productionStatus,
                "Verifying and activating the new production slot..."
            );

            await send({
                type:
                    "activateProductionSlot",
                slot
            });

            elements.productionProgress.value =
                100;

            setStatus(
                elements.productionStatus,
                `Production package activated in slot ${slot}.`,
                "success"
            );

            await refreshStatus();
        } catch (error) {
            if (slot !== null) {
                try {
                    await send({
                        type:
                            "failProductionSlot",
                        slot,
                        error:
                            getErrorMessage(error)
                    });
                } catch {
                }
            }

            setStatus(
                elements.productionStatus,
                "Production import failed: " +
                    getErrorMessage(error),
                "error"
            );

            await refreshStatus().catch(
                () => undefined
            );
        } finally {
            setOperationRunning(false);
        }
    }

    async function importManualFile() {
        if (operationRunning) {
            return;
        }

        const file =
            elements.manualFile.files[0];

        if (!file) {
            setStatus(
                elements.manualStatus,
                "Select a manual rule file.",
                "error"
            );
            return;
        }

        const category =
            elements.manualCategory.value;

        setOperationRunning(true);
        elements.manualProgress.value = 0;

        setStatus(
            elements.manualStatus,
            "Importing manual file..."
        );

        let importId = null;
        let validRules = 0;
        let rejectedRules = 0;
        let batch = [];

        try {
            const beginResponse =
                await send({
                    type:
                        "beginManualImport",
                    metadata: {
                        category,
                        fileName: file.name,
                        fileSize: file.size,
                        fileSha256: ""
                    }
                });

            importId =
                beginResponse.importId;

            for await (
                const record of readLines(file)
            ) {
                const rawLine =
                    String(record.line || "");

                if (
                    rawLine.length === 0 ||
                    rawLine.trim()
                        .startsWith("#")
                ) {
                    rejectedRules += 1;
                    continue;
                }

                const normalized =
                    normalizeRule(
                        rawLine,
                        category
                    );

                if (!normalized) {
                    rejectedRules += 1;
                    continue;
                }

                batch.push(normalized);
                validRules += 1;

                if (
                    batch.length >=
                    MANUAL_BATCH_SIZE
                ) {
                    await send({
                        type:
                            "putManualBatch",
                        importId,
                        category,
                        rules: batch
                    });

                    batch = [];

                    elements.manualProgress.value =
                        file.size > 0
                            ? Math.min(
                                99,
                                Math.floor(
                                    (
                                        record.bytesRead /
                                        file.size
                                    ) * 100
                                )
                            )
                            : 0;

                    setStatus(
                        elements.manualStatus,
                        `${validRules.toLocaleString()} valid, ` +
                            `${rejectedRules.toLocaleString()} rejected.`
                    );
                }
            }

            if (batch.length > 0) {
                await send({
                    type: "putManualBatch",
                    importId,
                    category,
                    rules: batch
                });
            }

            await send({
                type:
                    "completeManualImport",
                importId,
                result: {
                    validRules,
                    rejectedRules
                }
            });

            await send({
                type: "clearCaches"
            });

            elements.manualProgress.value =
                100;

            setStatus(
                elements.manualStatus,
                "Manual import completed: " +
                    `${validRules.toLocaleString()} valid, ` +
                    `${rejectedRules.toLocaleString()} rejected.`,
                "success"
            );

            elements.manualFile.value = "";
            updateManualSelection();
            await refreshStatus();
        } catch (error) {
            if (importId !== null) {
                try {
                    await send({
                        type:
                            "failManualImport",
                        importId,
                        error:
                            getErrorMessage(error)
                    });
                } catch {
                }
            }

            setStatus(
                elements.manualStatus,
                "Manual import failed: " +
                    getErrorMessage(error),
                "error"
            );

            await refreshStatus().catch(
                () => undefined
            );
        } finally {
            setOperationRunning(false);
        }
    }

    async function deleteProductionSlot(slot) {
        if (operationRunning) {
            return;
        }

        if (
            !window.confirm(
                `Delete production slot ${slot}?`
            )
        ) {
            return;
        }

        setOperationRunning(true);

        setStatus(
            elements.actionStatus,
            `Deleting production slot ${slot}...`
        );

        try {
            const response =
                await send({
                    type:
                        "deleteProductionSlot",
                    slot
                });

            const removed =
                response.result.removed;

            setStatus(
                elements.actionStatus,
                `Slot ${slot} deleted: ` +
                    `${formatCount(removed.labels)} labels, ` +
                    `${formatCount(removed.exactHosts)} exact hosts, ` +
                    `${formatCount(removed.pslOverrides)} overrides removed.`,
                "success"
            );

            await refreshStatus();
        } catch (error) {
            setStatus(
                elements.actionStatus,
                "Production-slot deletion failed: " +
                    getErrorMessage(error),
                "error"
            );
        } finally {
            setOperationRunning(false);
        }
    }

async function removeManualImport(record) {
    if (operationRunning) {
        return;
    }
    if (
        !window.confirm(
            `Remove manual import "${record.fileName}" from ` +
                `${CATEGORY_NAMES[record.category] || record.category}?`
        )
    ) {
        return;
    }
    setOperationRunning(true);
    setStatus(
        elements.actionStatus,
        `Removing ${record.fileName}...`
    );
    try {
        const response =
            await send({
                type:
                    "removeManualImport",
                importId:
                    record.importId
            });
        setStatus(
            elements.actionStatus,
            `Removed ${response.result.removedLinks.toLocaleString()} ` +
                "ownership links and " +
                `${response.result.removedRules.toLocaleString()} ` +
                "unreferenced rules.",
            "success"
        );
        await refreshStatus();
    } catch (error) {
        setStatus(
            elements.actionStatus,
            "Manual import removal failed: " +
                getErrorMessage(error),
            "error"
        );
    } finally {
        setOperationRunning(false);
    }
}
    function isSupportedDiagnosticUrl(value) {
        try {
            const url = new URL(value);
            if (
                url.protocol !== "http:" &&
                url.protocol !== "https:"
            ) {
                return false;
            }
            const hostname =
                url.hostname.toLowerCase();
            return (
                /(^|\.)google\./.test(
                    hostname
                ) ||
                /(^|\.)bing\.com$/.test(
                    hostname
                ) ||
                /(^|\.)duckduckgo\.com$/.test(
                    hostname
                ) ||
                hostname ===
                    "search.brave.com" ||
                hostname ===
                    "startpage.com" ||
                hostname.endsWith(
                    ".startpage.com"
                ) ||
                hostname ===
                    "searx.org" ||
                hostname.endsWith(
                    ".searx.org"
                ) ||
                hostname ===
                    "xka.cz" ||
                hostname.endsWith(
                    ".xka.cz"
                ) ||
                hostname ===
                    "searx.tiekoetter.com" ||
                hostname.endsWith(
                    ".searx.tiekoetter.com"
                ) ||
                hostname === "etools.ch" ||
                hostname.endsWith(
                    ".etools.ch"
                ) ||
                hostname === "wiby.org" ||
                hostname.endsWith(
                    ".wiby.org"
                ) ||
                hostname ===
                    "secretsearchenginelabs.com" ||
                hostname.endsWith(
                    ".secretsearchenginelabs.com"
                ) ||
                hostname === "rawweb.org" ||
                hostname.endsWith(
                    ".rawweb.org"
                ) ||
                hostname ===
                    "slsearch.eu.org" ||
                hostname.endsWith(
                    ".slsearch.eu.org"
                ) ||
                hostname ===
                    "searchthis.ch" ||
                hostname.endsWith(
                    ".searchthis.ch"
                ) ||
                hostname === "degoog.org" ||
                hostname.endsWith(
                    ".degoog.org"
                )
            );
        } catch {
            return false;
        }
    }
    async function refreshDiagnosticTabs() {
        const previousValue =
            elements.diagnosticsTab.value;
        const tabs =
            await browser.tabs.query({});
        const supportedTabs =
            tabs
                .filter(tab =>
                    Number.isInteger(tab.id) &&
                    typeof tab.url ===
                        "string" &&
                    isSupportedDiagnosticUrl(
                        tab.url
                    )
                )
                .sort(
                    (left, right) =>
                        Number(
                            right.lastAccessed ||
                                0
                        ) -
                        Number(
                            left.lastAccessed ||
                                0
                        )
                );
        elements.diagnosticsTab
            .replaceChildren();
        if (supportedTabs.length === 0) {
            const option =
                document.createElement(
                    "option"
                );
            option.value = "";
            option.textContent =
                "No supported search tabs found";
            elements.diagnosticsTab
                .appendChild(option);
            return;
        }
        for (const tab of supportedTabs) {
            const option =
                document.createElement(
                    "option"
                );
            option.value =
                String(tab.id);
            let hostname = "";
            try {
                hostname =
                    new URL(tab.url).hostname;
            } catch {
                hostname = tab.url;
            }
            option.textContent =
                `${hostname} - ` +
                `${tab.title || tab.url}`;
            elements.diagnosticsTab
                .appendChild(option);
        }
        if (
            Array.from(
                elements.diagnosticsTab.options
            ).some(
                option =>
                    option.value ===
                    previousValue
            )
        ) {
            elements.diagnosticsTab.value =
                previousValue;
        }
    }
    function getSelectedDiagnosticTabId() {
        const tabId =
            Number(
                elements.diagnosticsTab.value
            );
        if (
            !Number.isInteger(tabId) ||
            tabId < 0
        ) {
            throw new Error(
                "Select a supported search-results tab."
            );
        }
        return tabId;
    }
    async function collectDiagnostics() {
        if (operationRunning) {
            return;
        }
        setOperationRunning(true);
        setStatus(
            elements.actionStatus,
            "Requesting diagnostics from the selected tab..."
        );
        try {
            const tabId =
                getSelectedDiagnosticTabId();
            const response =
                await send({
                    type:
                        "collectTabDiagnostics",
                    tabId
                });
            const text =
                JSON.stringify(
                    response.diagnostics,
                    null,
                    2
                );
            elements.diagnosticsOutput.value =
                text;
            try {
                await navigator.clipboard
                    .writeText(text);
                setStatus(
                    elements.actionStatus,
                    "Diagnostics captured and copied to the clipboard.",
                    "success"
                );
            } catch {
                setStatus(
                    elements.actionStatus,
                    "Diagnostics captured. Copy them from the text box.",
                    "success"
                );
            }
        } catch (error) {
            elements.diagnosticsOutput.value =
                "";
            setStatus(
                elements.actionStatus,
                "Diagnostic capture failed: " +
                    getErrorMessage(error),
                "error"
            );
        } finally {
            setOperationRunning(false);
        }
    }
    async function proposeAdapter() {
        if (operationRunning) {
            return;
        }
        proposedAdapter = null;
        adapterPreviewActive = false;
        elements.adapterOutput.value = "";
        updateAdapterButtons();
        setOperationRunning(true);
        try {
            const tabId =
                getSelectedDiagnosticTabId();
            setStatus(
                elements.adapterStatus,
                "Analyzing repeated result structures..."
            );
            const response =
                await send({
                    type:
                        "proposeTabAdapter",
                    tabId
                });
            const result =
                response.result;
            if (
                !result ||
                typeof result !== "object"
            ) {
                throw new Error(
                    "The page did not return adapter analysis."
                );
            }
            elements.adapterOutput.value =
                JSON.stringify(
                    result,
                    null,
                    2
                );
            const proposal =
                result.proposal;
            if (!proposal) {
                const candidateCount =
                    Number(
                        result.candidateLinks ||
                            0
                    );
                const alternativeCount =
                    Array.isArray(
                        result.alternatives
                    )
                        ? result.alternatives
                            .length
                        : 0;
                throw new Error(
                    "No safe proposal passed the thresholds. " +
                    `${candidateCount} external links were examined; ` +
                    `${alternativeCount} alternatives were retained.`
                );
            }
            if (
                !result.page ||
                typeof result.page.hostname !==
                    "string" ||
                typeof result.page.pathname !==
                    "string"
            ) {
                throw new Error(
                    "The adapter proposal lacks page information."
                );
            }
            proposedAdapter = {
                hostname:
                    result.page.hostname
                        .trim()
                        .toLowerCase(),
                pathPattern:
                    "^" +
                    result.page.pathname
                        .replace(
                            /[.*+?^${}()|[\]\\]/g,
                            "\\$&"
                        ) +
                    "$",
                resultSelector:
                    proposal.resultSelector,
                linkSelector:
                    proposal.linkSelector,
                urlSources: [
                    "href",
                    "data-href",
                    "data-url"
                ],
                enabled: false,
                evidence: {
                    supportingLinks:
                        proposal
                            .supportingLinks,
                    resultMatches:
                        proposal
                            .resultMatches,
                    averageScore:
                        proposal
                            .averageScore
                }
            };
            elements.adapterOutput.value =
                JSON.stringify(
                    {
                        adapter:
                            proposedAdapter,
                        analysis: result
                    },
                    null,
                    2
                );
            setStatus(
                elements.adapterStatus,
                `Proposed ${proposal.resultSelector} with ` +
                    `${proposal.resultMatches} matches. ` +
                    "Preview the outlined containers before saving.",
                "success"
            );
        } catch (error) {
            proposedAdapter = null;
            adapterPreviewActive = false;
            setStatus(
                elements.adapterStatus,
                getErrorMessage(error),
                "error"
            );
        } finally {
            setOperationRunning(false);
        }
    }
    async function previewAdapter() {
        if (
            operationRunning ||
            proposedAdapter === null
        ) {
            return;
        }
        setOperationRunning(true);
        try {
            const tabId =
                getSelectedDiagnosticTabId();
            const response =
                await send({
                    type:
                        "previewTabAdapter",
                    tabId,
                    proposal:
                        proposedAdapter
                });
            adapterPreviewActive = true;
            setStatus(
                elements.adapterStatus,
                `Previewing ${response.result.matches} result containers. ` +
                    "Confirm that only individual results are outlined.",
                "success"
            );
        } catch (error) {
            adapterPreviewActive = false;
            setStatus(
                elements.adapterStatus,
                "Preview failed: " +
                    getErrorMessage(error),
                "error"
            );
        } finally {
            setOperationRunning(false);
        }
    }
    async function clearAdapterPreview() {
        if (
            operationRunning ||
            !adapterPreviewActive
        ) {
            return;
        }
        setOperationRunning(true);
        try {
            const tabId =
                getSelectedDiagnosticTabId();
            await send({
                type:
                    "clearTabAdapterPreview",
                tabId
            });
            adapterPreviewActive = false;
            setStatus(
                elements.adapterStatus,
                "Adapter preview cleared.",
                "success"
            );
        } catch (error) {
            setStatus(
                elements.adapterStatus,
                "Could not clear preview: " +
                    getErrorMessage(error),
                "error"
            );
        } finally {
            setOperationRunning(false);
        }
    }
    async function saveApprovedAdapter() {
        if (
            operationRunning ||
            proposedAdapter === null
        ) {
            return;
        }
        if (!adapterPreviewActive) {
            setStatus(
                elements.adapterStatus,
                "Preview the proposal before saving it.",
                "error"
            );
            return;
        }
        if (
            !window.confirm(
                "Save this adapter? Only approve it if the preview outlines individual result containers and leaves navigation, forms, and pagination untouched."
            )
        ) {
            return;
        }
        setOperationRunning(true);
        try {
            const response =
                await send({
                    type: "saveAdapter",
                    adapter: {
                        ...proposedAdapter,
                        enabled: true
                    }
                });
            proposedAdapter = {
                ...response.adapter,
                enabled: true
            };
            elements.adapterOutput.value =
                JSON.stringify(
                    proposedAdapter,
                    null,
                    2
                );
            setStatus(
                elements.adapterStatus,
                "Approved adapter saved. Reload the search page to test normal filtering.",
                "success"
            );
        } catch (error) {
            setStatus(
                elements.adapterStatus,
                "Could not save adapter: " +
                    getErrorMessage(error),
                "error"
            );
        } finally {
            setOperationRunning(false);
        }
    }
    async function deleteDatabase() {
        if (operationRunning) {
            return;
        }
        if (
            !window.confirm(
                "Delete the entire LeanSERP Filter Minimal database? " +
                    "Both production slots and all manual imports will be removed."
            )
        ) {
            return;
        }
        setOperationRunning(true);
        setStatus(
            elements.actionStatus,
            "Deleting the minimal database..."
        );
        try {
            await send({
                type: "clearAllDatabase"
            });
            setStatus(
                elements.actionStatus,
                "The database was deleted. Reloading manager...",
                "success"
            );
            window.setTimeout(
                () => {
                    location.reload();
                },
                500
            );
        } catch (error) {
            setStatus(
                elements.actionStatus,
                "Database deletion failed: " +
                    getErrorMessage(error),
                "error"
            );
            setOperationRunning(false);
        }
    }
    function installEventListeners() {
        for (
            const name of
            Object.keys(RULE_FILES)
        ) {
            getProductionInput(name)
                .addEventListener(
                    "change",
                    updateProductionSelections
                );
        }
        elements.manualFile.addEventListener(
            "change",
            updateManualSelection
        );
        elements.refreshStatus
            .addEventListener(
                "click",
                () => {
                    void refreshStatus()
                        .catch(error => {
                            setStatus(
                                elements.actionStatus,
                                "Refresh failed: " +
                                    getErrorMessage(
                                        error
                                    ),
                                "error"
                            );
                        });
                }
            );
        elements.importProduction
            .addEventListener(
                "click",
                () => {
                    void importProductionPackage();
                }
            );
        elements.importManual
            .addEventListener(
                "click",
                () => {
                    void importManualFile();
                }
            );
        elements.refreshDiagnosticsTabs
            .addEventListener(
                "click",
                () => {
                    void refreshDiagnosticTabs()
                        .catch(error => {
                            setStatus(
                                elements.actionStatus,
                                "Could not refresh the tab list: " +
                                    getErrorMessage(
                                        error
                                    ),
                                "error"
                            );
                        });
                }
            );
        elements.collectDiagnostics
            .addEventListener(
                "click",
                () => {
                    void collectDiagnostics();
                }
            );
        elements.proposeAdapter
            .addEventListener(
                "click",
                () => {
                    void proposeAdapter();
                }
            );
        elements.previewAdapter
            .addEventListener(
                "click",
                () => {
                    void previewAdapter();
                }
            );
        elements.clearAdapterPreview
            .addEventListener(
                "click",
                () => {
                    void clearAdapterPreview();
                }
            );
        elements.saveAdapter
            .addEventListener(
                "click",
                () => {
                    void saveApprovedAdapter();
                }
            );
        elements.clearCaches
            .addEventListener(
                "click",
                async () => {
                    try {
                        await send({
                            type: "clearCaches"
                        });
                        setStatus(
                            elements.actionStatus,
                            "Lookup caches cleared.",
                            "success"
                        );
                    } catch (error) {
                        setStatus(
                            elements.actionStatus,
                            "Cache clearing failed: " +
                                getErrorMessage(
                                    error
                                ),
                            "error"
                        );
                    }
                }
            );
        elements.deleteDatabase
            .addEventListener(
                "click",
                () => {
                    void deleteDatabase();
                }
            );
        elements.diagnosticsTab
            .addEventListener(
                "change",
                () => {
                    proposedAdapter = null;
                    adapterPreviewActive = false;
                    elements.adapterOutput.value =
                        "";
                    setStatus(
                        elements.adapterStatus,
                        "No adapter proposed."
                    );
                    updateAdapterButtons();
                }
            );
    }
    function showTabLoadingError(error) {
        elements.diagnosticsTab
            .replaceChildren();
        const option =
            document.createElement(
                "option"
            );
        option.value = "";
        option.textContent =
            "Could not load browser tabs";
        elements.diagnosticsTab
            .appendChild(option);
        setStatus(
            elements.actionStatus,
            "Could not load the tab list: " +
                getErrorMessage(error),
            "error"
        );
    }
    async function initializeManager() {
        assertElements();
        installEventListeners();
        updateProductionSelections();
        updateManualSelection();
        updateAdapterButtons();
        await Promise.allSettled([
            refreshDiagnosticTabs()
                .catch(error => {
                    showTabLoadingError(error);
                }),
            refreshStatus()
                .catch(error => {
                    setStatus(
                        elements.actionStatus,
                        "Could not load database status: " +
                            getErrorMessage(error),
                        "error"
                    );
                })
        ]);
    }
    void initializeManager().catch(error => {
        console.error(
            "LeanSERP manager initialization failed.",
            error
        );
        if (elements.actionStatus) {
            setStatus(
                elements.actionStatus,
                "Manager initialization failed: " +
                    getErrorMessage(error),
                "error"
            );
        }
    });
})();
