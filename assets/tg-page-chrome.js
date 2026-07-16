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

    const footer = document.querySelector(".site-footer");
    const updateFooterState = () => {
        if (!footer) {
            return;
        }
        const footerRect = footer.getBoundingClientRect();
        scrollTopBtn.classList.toggle(
            "is-footer-visible",
            footerRect.top < window.innerHeight && footerRect.bottom > 0,
        );
    };

    if (footer && "IntersectionObserver" in window) {
        const footerObserver = new IntersectionObserver(([entry]) => {
            scrollTopBtn.classList.toggle("is-footer-visible", entry.isIntersecting);
        }, { threshold: 0 });
        footerObserver.observe(footer);
    }

    window.addEventListener(
        "scroll",
        () => {
            scrollTopBtn.classList.toggle("is-visible", window.scrollY > 300);
            updateFooterState();
        },
        { passive: true },
    );

    scrollTopBtn.addEventListener("click", () => {
        window.scrollTo({ top: 0, behavior: "smooth" });
    });

    updateFooterState();
})();
