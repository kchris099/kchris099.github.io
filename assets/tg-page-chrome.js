(function initNavScrollSpy() {
    if (!("IntersectionObserver" in window)) {
        return;
    }

    const navLinks = new Map(
        Array.from(document.querySelectorAll('.nav-link[href^="#"]')).map((link) => {
            const href = link.getAttribute("href") || "";
            return [href.slice(1), link];
        }).filter(([id]) => id),
    );
    if (navLinks.size < 2) {
        return;
    }

    const observed = [];
    navLinks.forEach((link, id) => {
        let section = document.getElementById(id);
        if (!section) {
            return;
        }
        // Country pages put #regions / #atlas inside #main-content. Observing
        // the wrapper would keep it intersecting forever, so spy the hero
        // instead while the hash still targets main for skip/scroll links.
        if (
            section.matches("main") &&
            section.querySelector(".country-hero, .hero, .country-hero-v2")
        ) {
            section =
                section.querySelector(".country-hero, .hero, .country-hero-v2") ||
                section;
        }
        observed.push({ id, link, section });
    });
    if (observed.length < 2) {
        return;
    }

    let activeId = null;
    const setActive = (id) => {
        if (id === activeId) {
            return;
        }
        activeId = id;
        navLinks.forEach((link, linkId) => {
            if (linkId === id) {
                link.setAttribute("aria-current", "location");
            } else {
                link.removeAttribute("aria-current");
            }
        });
    };

    const intersecting = new Set();
    const sectionObserver = new IntersectionObserver(
        (entries) => {
            entries.forEach((entry) => {
                const id = entry.target.dataset.tgNavSpyId;
                if (!id) {
                    return;
                }
                if (entry.isIntersecting) {
                    intersecting.add(id);
                } else {
                    intersecting.delete(id);
                }
            });

            // Prefer the last intersecting section in document order (matches
            // index.html behavior when adjacent sections overlap the band).
            let chosen = null;
            observed.forEach(({ id }) => {
                if (intersecting.has(id)) {
                    chosen = id;
                }
            });
            if (chosen) {
                setActive(chosen);
            }
        },
        { rootMargin: "-35% 0px -55% 0px", threshold: 0 },
    );

    observed.forEach(({ id, section }) => {
        section.dataset.tgNavSpyId = id;
        sectionObserver.observe(section);
    });
})();

(function initHeroTitleFit() {
    // Country hero titles are sized in CSS via --hero-title-chars.
    // Do not measure/scale on load, fonts.ready, or ResizeObserver — those
    // paths reintroduced a visible shrink flash on long names (e.g. Bosnia).
    // Clear any stale inline scale left from older page-chrome builds.
    if (!document.body?.classList.contains("tg-country-v2")) {
        return;
    }

    document.querySelectorAll(".hero__title").forEach((title) => {
        if (title.style.getPropertyValue("--hero-title-scale")) {
            title.style.removeProperty("--hero-title-scale");
        }
    });
})();

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
