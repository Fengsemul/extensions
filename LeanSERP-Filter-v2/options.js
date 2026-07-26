"use strict";
(() => {
    const DEFAULT_SETTINGS = Object.freeze({
        enabled: true,
        blockImages: false,
        blockMedia: false,
        disableAutoplay: false,
        suppressPrefetch: false,
        removeAiSummaries: false,
        removePeopleAlsoAsk: false,
        removeDiscussionsForums: false,
        removeCarousels: false,
		removeRelatedSearches: false,
        disableAnimations: true,
        pauseHiddenTabs: true,
        textOnlyMode: false,
        preferLiteInterfaces: false,
        limitInfiniteScrolling: false,
        infiniteScrollResultLimit: 100,
        automaticPagination: false,
        paginationTargetVisibleResults: 20,
        paginationMaximumPages: 5,
        paginationMaximumProcessedResults: 500,
        paginationDelayMilliseconds: 1000,
        paginationEmptyPageLimit: 2,
        paginationStopOnCaptcha: true,
        paginationPauseHiddenTabs: true,
        paginationMaximumElapsedSeconds: 60,
        deleteBlockedResults: true,
        decodeKnownRedirects: true,
        experimentalWindowStop: false
    });

    const BOOLEAN_SETTINGS = Object.freeze([
        "enabled",
        "blockImages",
        "blockMedia",
        "disableAutoplay",
        "suppressPrefetch",
        "removeAiSummaries",
        "removePeopleAlsoAsk",
        "removeDiscussionsForums",
        "removeCarousels",
		"removeRelatedSearches",
        "disableAnimations",
        "pauseHiddenTabs",
        "textOnlyMode",
        "preferLiteInterfaces",
        "limitInfiniteScrolling",
        "automaticPagination",
        "paginationStopOnCaptcha",
        "paginationPauseHiddenTabs",
        "deleteBlockedResults",
        "decodeKnownRedirects",
        "experimentalWindowStop"
    ]);

    const NUMBER_SETTINGS = Object.freeze({
        infiniteScrollResultLimit: Object.freeze({
            minimum: 20,
            maximum: 5000
        }),
        paginationTargetVisibleResults: Object.freeze({
            minimum: 1,
            maximum: 500
        }),
        paginationMaximumPages: Object.freeze({
            minimum: 1,
            maximum: 50
        }),
        paginationMaximumProcessedResults: Object.freeze({
            minimum: 10,
            maximum: 5000
        }),
        paginationDelayMilliseconds: Object.freeze({
            minimum: 250,
            maximum: 10000
        }),
        paginationEmptyPageLimit: Object.freeze({
            minimum: 1,
            maximum: 10
        }),
        paginationMaximumElapsedSeconds: Object.freeze({
            minimum: 5,
            maximum: 600
        })
    });

    const form = document.getElementById(
        "settings-form"
    );

    const status = document.getElementById(
        "status"
    );

    const saveButton = document.getElementById(
        "save-settings"
    );

    const restoreButton = document.getElementById(
        "restore-defaults"
    );

    const paginationToggle =
        document.getElementById(
            "automaticPagination"
        );

    const infiniteScrollToggle =
        document.getElementById(
            "limitInfiniteScrolling"
        );

    function setStatus(message, state = "") {
        status.textContent = message;

        if (state) {
            status.dataset.state = state;
        } else {
            delete status.dataset.state;
        }
    }

    function getInput(name) {
        return document.getElementById(name);
    }

    function clampInteger(
        value,
        fallback,
        minimum,
        maximum
    ) {
        const number = Number(value);

        if (!Number.isFinite(number)) {
            return fallback;
        }

        return Math.min(
            maximum,
            Math.max(
                minimum,
                Math.round(number)
            )
        );
    }

    function normalizeSettings(value) {
        const source =
            value &&
            typeof value === "object"
                ? value
                : {};

        const normalized = {
            ...DEFAULT_SETTINGS
        };

        for (const name of BOOLEAN_SETTINGS) {
            normalized[name] =
                typeof source[name] === "boolean"
                    ? source[name]
                    : DEFAULT_SETTINGS[name];
        }

        for (
            const [
                name,
                limits
            ] of Object.entries(
                NUMBER_SETTINGS
            )
        ) {
            normalized[name] =
                clampInteger(
                    source[name],
                    DEFAULT_SETTINGS[name],
                    limits.minimum,
                    limits.maximum
                );
        }

        return normalized;
    }

    function readFormSettings() {
        const settings = {
            ...DEFAULT_SETTINGS
        };

        for (const name of BOOLEAN_SETTINGS) {
            const input = getInput(name);

            settings[name] = Boolean(
                input && input.checked
            );
        }

        for (
            const [
                name,
                limits
            ] of Object.entries(
                NUMBER_SETTINGS
            )
        ) {
            const input = getInput(name);

            settings[name] =
                clampInteger(
                    input ? input.value : "",
                    DEFAULT_SETTINGS[name],
                    limits.minimum,
                    limits.maximum
                );
        }

        return settings;
    }

    function writeFormSettings(value) {
        const settings =
            normalizeSettings(value);

        for (const name of BOOLEAN_SETTINGS) {
            const input = getInput(name);

            if (input) {
                input.checked =
                    settings[name];
            }
        }

        for (const name of Object.keys(
            NUMBER_SETTINGS
        )) {
            const input = getInput(name);

            if (input) {
                input.value =
                    String(settings[name]);
            }
        }

        updateDependentControls();
    }

    function setFormDisabled(disabled) {
        saveButton.disabled = disabled;
        restoreButton.disabled = disabled;

        for (const name of BOOLEAN_SETTINGS) {
            const input = getInput(name);

            if (input) {
                input.disabled = disabled;
            }
        }

        for (const name of Object.keys(
            NUMBER_SETTINGS
        )) {
            const input = getInput(name);

            if (input) {
                input.disabled = disabled;
            }
        }

        if (!disabled) {
            updateDependentControls();
        }
    }

    function updateDependentControls() {
        const paginationEnabled =
            Boolean(
                paginationToggle &&
                paginationToggle.checked
            );

        for (const name of [
            "paginationTargetVisibleResults",
            "paginationMaximumPages",
            "paginationMaximumProcessedResults",
            "paginationDelayMilliseconds",
            "paginationEmptyPageLimit",
            "paginationStopOnCaptcha",
            "paginationPauseHiddenTabs",
            "paginationMaximumElapsedSeconds"
        ]) {
            const input = getInput(name);

            if (input) {
                input.disabled =
                    !paginationEnabled;
            }
        }

        const infiniteScrollEnabled =
            Boolean(
                infiniteScrollToggle &&
                infiniteScrollToggle.checked
            );

        const infiniteLimit =
            getInput(
                "infiniteScrollResultLimit"
            );

        if (infiniteLimit) {
            infiniteLimit.disabled =
                !infiniteScrollEnabled;
        }
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

    async function loadSettings() {
        setFormDisabled(true);
        setStatus("Loading settings...");

        try {
            const response =
                await send({
                    type: "getSettings"
                });

            writeFormSettings(
                response.settings
            );

            setStatus(
                "Settings loaded.",
                "success"
            );
        } catch (error) {
            writeFormSettings(
                DEFAULT_SETTINGS
            );

            setStatus(
                "Could not load settings: " +
                    (
                        error &&
                        error.message
                            ? error.message
                            : String(error)
                    ),
                "error"
            );
        } finally {
            setFormDisabled(false);
        }
    }

    async function saveSettings(event) {
        event.preventDefault();
        setFormDisabled(true);
        setStatus("Saving settings...");

        try {
            const response =
                await send({
                    type: "saveSettings",
                    settings:
                        readFormSettings()
                });

            writeFormSettings(
                response.settings
            );

            setStatus(
                "Settings saved. Reload open search pages to apply every change.",
                "success"
            );
        } catch (error) {
            setStatus(
                "Save failed: " +
                    (
                        error &&
                        error.message
                            ? error.message
                            : String(error)
                    ),
                "error"
            );
        } finally {
            setFormDisabled(false);
        }
    }

    async function restoreDefaults() {
        setFormDisabled(true);
        setStatus("Restoring defaults...");

        try {
            const response =
                await send({
                    type: "saveSettings",
                    settings: {
                        ...DEFAULT_SETTINGS
                    }
                });

            writeFormSettings(
                response.settings
            );

            setStatus(
                "Default settings restored.",
                "success"
            );
        } catch (error) {
            setStatus(
                "Restore failed: " +
                    (
                        error &&
                        error.message
                            ? error.message
                            : String(error)
                    ),
                "error"
            );
        } finally {
            setFormDisabled(false);
        }
    }

    form.addEventListener(
        "submit",
        event => {
            void saveSettings(event);
        }
    );

    restoreButton.addEventListener(
        "click",
        () => {
            void restoreDefaults();
        }
    );

    paginationToggle.addEventListener(
        "change",
        updateDependentControls
    );

    infiniteScrollToggle.addEventListener(
        "change",
        updateDependentControls
    );

    void loadSettings();
})();