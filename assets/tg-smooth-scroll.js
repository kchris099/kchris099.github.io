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

    const HEADER_CLEARANCE = 80;
    // Padded destination/country sections: land on content, not empty top padding.
    const PADDED_SECTION_SELECTOR = [
        ".destination-atlas",
        ".destination-places",
        ".regions-section",
        ".country-map-section",
    ].join(", ");

    const navScrollOffset = (target) => {
        if (!(target instanceof Element) || !target.matches(PADDED_SECTION_SELECTOR)) {
            return -HEADER_CLEARANCE;
        }
        const pad = Number.parseFloat(window.getComputedStyle(target).paddingTop) || 0;
        // Skip half the top padding so content is in view without overshooting.
        return pad * 0.5 - HEADER_CLEARANCE;
    };

    const scrollExemptSelector = [
        ".country-map-root",
        ".country-map-panel",
        "#world-map",
        ".jvm-container",
        ".continent-dropdown__list",
        ".custom-scrollbar",
        ".country-map-inset-drawer__panel",
        ".search-results",
        ".places-explorer__list",
        "[data-tg-scroll-surface]",
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

    // Chrome's middle-button autoscroll drives the window natively. If Lenis is
    // still active, its animation frame can keep restoring the previous target
    // (most noticeably at the bottom of the page) until the easing completes.
    // Yield to native scrolling after a middle click, then resume Lenis before
    // the next regular input reaches its own event listeners.
    let isNativeAutoScrolling = false;

    const resumeSmoothScroll = () => {
        if (!isNativeAutoScrolling) {
            return;
        }
        isNativeAutoScrolling = false;
        lenis.start();
    };

    window.addEventListener("mousedown", (event) => {
        if (event.button === 1) {
            isNativeAutoScrolling = true;
            lenis.stop();
            return;
        }
        resumeSmoothScroll();
    }, { capture: true });
    window.addEventListener("wheel", resumeSmoothScroll, { capture: true, passive: true });
    window.addEventListener("touchstart", resumeSmoothScroll, { capture: true, passive: true });
    window.addEventListener("keydown", resumeSmoothScroll, { capture: true });

    function raf(time) {
        lenis.raf(time);
        requestAnimationFrame(raf);
    }

    requestAnimationFrame(raf);

    function bindChrome() {
        const header = document.getElementById("site-header");
        const scrollTopBtn = document.getElementById("scrollTopBtn");
        const footer = document.querySelector(".site-footer");

        const updateFooterState = () => {
            if (!footer || !scrollTopBtn) {
                return;
            }
            const footerRect = footer.getBoundingClientRect();
            scrollTopBtn.classList.toggle(
                "is-footer-visible",
                footerRect.top < window.innerHeight && footerRect.bottom > 0,
            );
        };

        lenis.on("scroll", ({ scroll }) => {
            if (header) {
                header.classList.toggle("scrolled", scroll > 60);
            }
            if (scrollTopBtn) {
                scrollTopBtn.classList.toggle("is-visible", scroll > 300);
            }
            updateFooterState();
        });

        if (scrollTopBtn) {
            scrollTopBtn.addEventListener("click", () => {
                lenis.scrollTo(0, { duration: 1.2 });
            });
        }

        if (footer && scrollTopBtn && "IntersectionObserver" in window) {
            const footerObserver = new IntersectionObserver(([entry]) => {
                scrollTopBtn.classList.toggle("is-footer-visible", entry.isIntersecting);
            }, { threshold: 0 });
            footerObserver.observe(footer);
        }

        updateFooterState();

        document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
            anchor.addEventListener("click", (event) => {
                const id = anchor.getAttribute("href");
                if (!id || id === "#" || id.length < 2) {
                    return;
                }
                const target = document.querySelector(id);
                if (target) {
                    event.preventDefault();
                    lenis.scrollTo(target, {
                        offset: navScrollOffset(target),
                        duration: 1.4,
                    });
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
            const { offset, ...rest } = options;
            lenis.scrollTo(target, {
                offset: offset ?? navScrollOffset(target),
                duration: 1.4,
                ...rest,
            });
        },
    };
})();
