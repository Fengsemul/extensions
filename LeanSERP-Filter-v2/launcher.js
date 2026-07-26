"use strict";

(() => {
    const managerButton =
        document.getElementById(
            "open-manager"
        );

    const optionsButton =
        document.getElementById(
            "open-options"
        );

    const status =
        document.getElementById(
            "status"
        );

    let opening = false;

    function setDisabled(disabled) {
        managerButton.disabled = disabled;
        optionsButton.disabled = disabled;
    }

    function showError(error) {
        status.textContent =
            error && error.message
                ? error.message
                : String(error);

        status.dataset.state = "error";
    }

    managerButton.addEventListener(
        "click",
        async () => {
            if (opening) {
                return;
            }

            opening = true;
            setDisabled(true);
            status.textContent =
                "Opening manager...";

            try {
                await browser.tabs.create({
                    url: browser.runtime.getURL(
                        "manager.html"
                    )
                });

                window.close();
            } catch (error) {
                showError(error);
                opening = false;
                setDisabled(false);
            }
        }
    );

    optionsButton.addEventListener(
        "click",
        async () => {
            if (opening) {
                return;
            }

            opening = true;
            setDisabled(true);
            status.textContent =
                "Opening options...";

            try {
                await browser.runtime
                    .openOptionsPage();

                window.close();
            } catch (error) {
                showError(error);
                opening = false;
                setDisabled(false);
            }
        }
    );
})();