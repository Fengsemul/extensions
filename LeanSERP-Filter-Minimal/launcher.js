"use strict";
(() => {
    const openButton =
        document.getElementById(
            "open-manager"
        );
    const status =
        document.getElementById(
            "status"
        );

    function showError(error) {
        status.textContent =
            "Could not open the manager: " +
            (
                error && error.message
                    ? error.message
                    : String(error)
            );
        status.dataset.state = "error";
        openButton.disabled = false;
    }

    openButton.addEventListener(
        "click",
        async () => {
            openButton.disabled = true;
            status.textContent =
                "Opening manager...";
            delete status.dataset.state;

            try {
                await browser.tabs.create({
                    url: browser.runtime.getURL(
                        "manager.html"
                    )
                });
                window.close();
            } catch (error) {
                showError(error);
            }
        }
    );
})();