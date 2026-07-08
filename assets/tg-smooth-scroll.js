(function initTgLenisScroll() {
    if (typeof window === "undefined" || typeof document === "undefined") {
        return;
    }

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        return;
    }

    if (typeof Lenis === "undefined") {
        return;
    }

    const scrollExemptSelector = [
        ".country-map-root",
        ".country-map-panel",
        "#world-map",
        ".jvm-container",
        ".continent-dropdown__list",
        ".custom-scrollbar",
        ".country-map-inset-drawer__panel",
    ].join(", ");

    const isExempt = (node) =>
        node instanceof Element && Boolean(node.closest(scrollExemptSelector));

    const lenis = new Lenis({
        duration: 1.2,
        easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
        smoothWheel: true,
        touchMultiplier: 1.5,
        prevent: (node) => isExempt(node),
    });

    function raf(time) {
        lenis.raf(time);
        requestAnimationFrame(raf);
    }

    requestAnimationFrame(raf);

    function bindChrome() {
        const header = document.getElementById("site-header");
        const scrollTopBtn = document.getElementById("scrollTopBtn");

        lenis.on("scroll", ({ scroll }) => {
            if (header) {
                header.classList.toggle("scrolled", scroll > 60);
            }
            if (scrollTopBtn) {
                scrollTopBtn.classList.toggle("is-visible", scroll > 300);
            }
        });

        if (scrollTopBtn) {
            scrollTopBtn.addEventListener("click", () => {
                lenis.scrollTo(0, { duration: 1.2 });
            });
        }

        document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
            anchor.addEventListener("click", (event) => {
                const id = anchor.getAttribute("href");
                if (!id || id === "#" || id.length < 2) {
                    return;
                }
                const target = document.querySelector(id);
                if (target) {
                    event.preventDefault();
                    lenis.scrollTo(target, { offset: -80, duration: 1.4 });
                }
            });
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", bindChrome);
    } else {
        bindChrome();
    }

    window.TGSmoothScroll = {
        lenis,
        scrollTo(y) {
            lenis.scrollTo(y, { duration: 1.2 });
        },
        scrollToElement(target, options = {}) {
            lenis.scrollTo(target, {
                offset: -80,
                duration: 1.4,
                ...options,
            });
        },
    };
})();
