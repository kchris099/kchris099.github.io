(function initTgPageChrome() {
    if (window.TGSmoothScroll?.lenis) {
        return;
    }

    const header = document.getElementById("site-header");
    if (header) {
        window.addEventListener(
            "scroll",
            () => {
                header.classList.toggle("scrolled", window.scrollY > 60);
            },
            { passive: true },
        );
    }

    const scrollTopBtn = document.getElementById("scrollTopBtn");
    if (!scrollTopBtn) {
        return;
    }

    window.addEventListener(
        "scroll",
        () => {
            scrollTopBtn.classList.toggle("is-visible", window.scrollY > 300);
        },
        { passive: true },
    );

    scrollTopBtn.addEventListener("click", () => {
        window.scrollTo({ top: 0, behavior: "smooth" });
    });
})();
