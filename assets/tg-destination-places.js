/**
 * Destination Places Explorer: index rail + sticky stage, map bridge.
 * Content stays visible by default; JS only adds .is-enhanced single-panel mode,
 * photo-side step arrows, swipe, and a non-VT photo slide (text swaps instantly).
 */
(function initTGDestinationPlaces() {
    const REDUCE_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const SWIPE_THRESHOLD = 56;
    const SWIPE_VELOCITY = 0.45;
    const SWIPE_AXIS_PX = 4;
    const TRANSITION_MS_DEFAULT = 420;
    const TRANSITION_MS_CLICK = 200;
    const TRANSITION_MS_MIN = 50;
    const TRANSITION_MS_MAX = 420;
    /**
     * Effective travel (px) for catch-up timing at full remaining distance.
     * At ~2.2px/ms this reaches the 50ms floor; slow drags clamp to 420ms.
     */
    const TRANSITION_TRAVEL_PX = 110;

    function clamp(n, min, max) {
        return Math.min(max, Math.max(min, n));
    }

    /**
     * Continuous catch-up: duration = effectiveTravel / speed, clamped to [50, 420].
     * No slow/fast buckets — only finger speed + how far you've already dragged.
     */
    function transitionMsFromSwipe(dx, avgVelocity, flickVelocity, mediaWidth) {
        const speed = Math.max(Math.abs(avgVelocity), Math.abs(flickVelocity), 0.08);
        const width = Math.max(160, mediaWidth || 320);
        const remainRatio = clamp((width - Math.abs(dx)) / width, 0.25, 1);
        const travel = TRANSITION_TRAVEL_PX * remainRatio;
        return Math.round(clamp(travel / speed, TRANSITION_MS_MIN, TRANSITION_MS_MAX));
    }

    const ARROW_PREV = `
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M14.75 5.25 L8.25 12 l6.5 6.75" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" stroke-linejoin="miter"/>
            <path d="M9.1 12 H17.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square"/>
        </svg>
    `.trim();

    const ARROW_NEXT = `
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M9.25 5.25 L15.75 12 l-6.5 6.75" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" stroke-linejoin="miter"/>
            <path d="M6.6 12 H14.9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square"/>
        </svg>
    `.trim();

    function formatIndex(n) {
        return String(n).padStart(2, "0");
    }

    function ensureStepper(stage) {
        let stepper = stage.querySelector("[data-places-stepper]");
        if (!stepper) {
            stepper = document.createElement("nav");
            stepper.className = "places-stage__stepper";
            stepper.dataset.placesStepper = "";
            stepper.setAttribute("aria-label", "Browse places");
            stepper.innerHTML = `
                <button type="button" class="places-stage__arrow places-stage__arrow--prev" data-places-prev aria-label="Previous place">
                    ${ARROW_PREV}
                </button>
                <button type="button" class="places-stage__arrow places-stage__arrow--next" data-places-next aria-label="Next place">
                    ${ARROW_NEXT}
                </button>
            `;
        }
        stepper.hidden = false;
        return stepper;
    }

    function initExplorer(root) {
        if (!root || root.dataset.placesReady === "true") {
            return;
        }

        const list = root.querySelector("[data-places-list]");
        const stage = root.querySelector("[data-places-stage]");
        const filterInput = root.querySelector("[data-places-filter]");
        const countEl = root.querySelector("[data-places-count]");
        const emptyEl = root.querySelector("[data-places-empty]");
        const options = Array.from(root.querySelectorAll("[data-place-option]"));
        const panels = Array.from(root.querySelectorAll("[data-place-panel]"));

        if (!list || !stage || options.length === 0 || panels.length === 0) {
            return;
        }

        root.classList.add("is-enhanced");
        root.dataset.placesReady = "true";

        const stepper = ensureStepper(stage);
        const prevBtn = stepper.querySelector("[data-places-prev]");
        const nextBtn = stepper.querySelector("[data-places-next]");

        let activeIndex = 0;
        const initial = options.findIndex((el) => el.getAttribute("aria-selected") === "true");
        if (initial >= 0) {
            activeIndex = Number(options[initial].dataset.placeIndex || initial);
        }

        let swipe = null;
        let mediaSlideTimer = 0;

        function visibleOptions() {
            return options.filter((el) => !el.hidden && el.getAttribute("aria-hidden") !== "true");
        }

        function activePanel() {
            return panels.find((el) => Number(el.dataset.placeIndex) === activeIndex) || null;
        }

        function activeMedia() {
            return activePanel()?.querySelector(".places-stage__media") || null;
        }

        function mountStepper(media) {
            if (!media) {
                return;
            }
            if (stepper.parentElement !== media) {
                media.appendChild(stepper);
            }
        }

        function clearDrag(media) {
            if (!media) {
                return;
            }
            media.classList.remove("is-dragging", "is-swiping-lock", "is-bouncing", "has-peek");
            media.style.removeProperty("--places-drag-x");
            const peek = media.querySelector("[data-places-peek]");
            if (peek) {
                peek.hidden = true;
                peek.style.removeProperty("--places-peek-x");
            }
        }

        function bounceDrag(media) {
            if (!media) {
                return;
            }
            // Drop the live-drag lock first so CSS can spring the photo home.
            media.classList.remove("is-dragging", "is-swiping-lock", "has-peek");
            const peek = media.querySelector("[data-places-peek]");
            if (peek) {
                peek.hidden = true;
                peek.style.removeProperty("--places-peek-x");
            }
            media.classList.add("is-bouncing");
            void media.offsetWidth;
            media.style.setProperty("--places-drag-x", "0px");
            window.setTimeout(() => {
                media.classList.remove("is-bouncing");
                media.style.removeProperty("--places-drag-x");
            }, REDUCE_MOTION ? 0 : 320);
        }

        function ensurePeek(media) {
            let peek = media.querySelector("[data-places-peek]");
            if (!peek) {
                peek = document.createElement("div");
                peek.className = "places-stage__media-peek";
                peek.dataset.placesPeek = "";
                peek.hidden = true;
                peek.setAttribute("aria-hidden", "true");
                peek.innerHTML = '<img alt="" decoding="async" draggable="false">';
                const mainImg = media.querySelector(":scope > img");
                if (mainImg) {
                    media.insertBefore(peek, mainImg);
                } else {
                    media.prepend(peek);
                }
            }
            return peek;
        }

        function updatePeek(media, dx) {
            if (!media || !dx) {
                return;
            }
            const delta = dx < 0 ? 1 : -1;
            const idx = neighborIndex(delta);
            if (idx == null) {
                const peek = media.querySelector("[data-places-peek]");
                if (peek) {
                    peek.hidden = true;
                }
                media.classList.remove("has-peek");
                return;
            }

            const neighborPanel = panels.find((el) => Number(el.dataset.placeIndex) === idx);
            const neighborImg = neighborPanel?.querySelector(".places-stage__media img");
            const src = neighborImg?.currentSrc || neighborImg?.getAttribute("src") || "";
            if (!src) {
                return;
            }

            const peek = ensurePeek(media);
            const img = peek.querySelector("img");
            if (img && img.dataset.peekSrc !== src) {
                img.src = src;
                img.dataset.peekSrc = src;
            }

            const offset = dragOffset(dx);
            // Next comes from the right (+100%); previous from the left (−100%).
            const base = delta > 0 ? 100 : -100;
            peek.style.setProperty("--places-peek-x", `calc(${base}% + ${offset}px)`);
            peek.hidden = false;
            media.classList.add("has-peek");
        }

        function dragOffset(dx) {
            const pullingPrev = dx > 0;
            const pullingNext = dx < 0;
            const atEdge =
                (pullingPrev && neighborIndex(-1) == null) ||
                (pullingNext && neighborIndex(1) == null);

            if (!atEdge) {
                return dx * 0.82;
            }

            // Rubber-band past the first / last place.
            const abs = Math.abs(dx);
            const resisted = Math.min(abs, 96) * 0.32 + Math.max(0, abs - 96) * 0.1;
            return Math.sign(dx) * resisted;
        }

        function updateStepControls() {
            const visible = visibleOptions();
            const pos = visible.findIndex((el) => Number(el.dataset.placeIndex) === activeIndex);
            const atStart = pos <= 0;
            const atEnd = pos < 0 || pos >= visible.length - 1;
            if (prevBtn) {
                prevBtn.disabled = atStart;
            }
            if (nextBtn) {
                nextBtn.disabled = atEnd;
            }
            const label = pos >= 0 ? `${formatIndex(pos + 1)} of ${formatIndex(visible.length)}` : "";
            stepper.dataset.stepLabel = label;
            if (prevBtn) {
                prevBtn.setAttribute("aria-label", label ? `Previous place (${label})` : "Previous place");
            }
            if (nextBtn) {
                nextBtn.setAttribute("aria-label", label ? `Next place (${label})` : "Next place");
            }
        }

        function neighborIndex(delta) {
            const visible = visibleOptions();
            if (visible.length === 0) {
                return null;
            }
            const currentPos = visible.findIndex((el) => Number(el.dataset.placeIndex) === activeIndex);
            if (currentPos < 0) {
                return Number(visible[0].dataset.placeIndex);
            }
            const nextPos = currentPos + delta;
            if (nextPos < 0 || nextPos >= visible.length) {
                return null;
            }
            return Number(visible[nextPos].dataset.placeIndex);
        }

        function cancelMediaSlide() {
            if (mediaSlideTimer) {
                window.clearTimeout(mediaSlideTimer);
                mediaSlideTimer = 0;
            }
            root.querySelectorAll(".places-stage__media-cover").forEach((el) => el.remove());
            root.querySelectorAll(".places-stage__media.is-media-slide").forEach((el) => {
                el.classList.remove("is-media-slide", "is-media-slide-on");
                el.style.removeProperty("--tg-places-dir");
                el.style.removeProperty("--tg-places-ms");
            });
        }

        /**
         * Slide the photo with a cover layer. Text swaps instantly in `mutate`;
         * only the outgoing photo covers the new one during the transition.
         */
        function runWithTransition(mutate, direction, durationMs = TRANSITION_MS_DEFAULT) {
            const fromMedia = activeMedia();
            const fromImg = fromMedia?.querySelector(":scope > img");
            const fromSrc = fromImg?.currentSrc || fromImg?.getAttribute("src") || "";
            const dir = direction > 0 ? 1 : -1;
            const ms = clamp(Number(durationMs) || TRANSITION_MS_DEFAULT, TRANSITION_MS_MIN, TRANSITION_MS_MAX);

            cancelMediaSlide();

            // Instant DOM swap — title/body update with no crossfade layer.
            mutate();

            if (REDUCE_MOTION || !fromSrc || !mediaSafeForSlide()) {
                return;
            }

            const toMedia = activeMedia();
            if (!toMedia) {
                return;
            }

            let cover = toMedia.querySelector(":scope > .places-stage__media-cover");
            if (!cover) {
                cover = document.createElement("div");
                cover.className = "places-stage__media-cover";
                cover.setAttribute("aria-hidden", "true");
                cover.innerHTML = '<img alt="" decoding="async" draggable="false">';
                const mainImg = toMedia.querySelector(":scope > img");
                if (mainImg) {
                    toMedia.insertBefore(cover, mainImg);
                } else {
                    toMedia.prepend(cover);
                }
            }
            const coverImg = cover.querySelector("img");
            if (coverImg) {
                coverImg.src = fromSrc;
            }

            toMedia.style.setProperty("--tg-places-dir", String(dir));
            toMedia.style.setProperty("--tg-places-ms", `${ms}ms`);
            document.documentElement.style.setProperty("--tg-places-dir", String(dir));
            document.documentElement.style.setProperty("--tg-places-ms", `${ms}ms`);
            root.dataset.placesDir = dir > 0 ? "next" : "prev";

            toMedia.classList.add("is-media-slide");
            cover.hidden = false;
            // Next: old exits left, new enters from right. Prev: mirrored.
            toMedia.style.setProperty("--places-drag-x", `calc(${dir} * 100%)`);
            cover.style.setProperty("--places-cover-x", "0%");
            void toMedia.offsetWidth;
            toMedia.classList.add("is-media-slide-on");
            toMedia.style.setProperty("--places-drag-x", "0px");
            cover.style.setProperty("--places-cover-x", `calc(${dir} * -100%)`);

            mediaSlideTimer = window.setTimeout(() => {
                mediaSlideTimer = 0;
                cancelMediaSlide();
                document.documentElement.style.removeProperty("--tg-places-dir");
                document.documentElement.style.removeProperty("--tg-places-ms");
                delete root.dataset.placesDir;
            }, ms + 40);
        }

        function mediaScrollClearance() {
            const header = document.getElementById("site-header");
            const headerHeight = header?.getBoundingClientRect().height;
            // Clear the fixed glass header; fall back to destination scroll-padding (7rem).
            if (Number.isFinite(headerHeight) && headerHeight > 0) {
                return headerHeight + 12;
            }
            return 112;
        }

        /** True when the active photo is fully clear of the fixed header. */
        function mediaSafeForSlide() {
            const media = activeMedia();
            if (!media) {
                return false;
            }
            const rect = media.getBoundingClientRect();
            if (rect.height < 8 || rect.width < 8) {
                return false;
            }
            const headerBottom = mediaScrollClearance() - 12;
            // Any overlap with the header (or off the top) → skip the slide cover.
            if (rect.top < headerBottom - 1) {
                return false;
            }
            // Mostly below the fold — same top-layer glitch risk.
            if (rect.top > window.innerHeight - 48) {
                return false;
            }
            return true;
        }

        function scrollMediaIntoView(media) {
            if (!media) {
                return;
            }

            const run = () => {
                // Ensure a just-unhidden panel has a real box before measuring.
                void media.offsetHeight;
                const clearance = mediaScrollClearance();
                // Use window.scrollY — Lenis element targeting uses animatedScroll,
                // which can lag native touch scroll and undershoot (mid-image stop).
                const y = Math.max(
                    0,
                    Math.round(media.getBoundingClientRect().top + window.scrollY - clearance),
                );

                const lenis = window.TGSmoothScroll?.lenis;
                if (lenis) {
                    lenis.scrollTo(y, {
                        duration: REDUCE_MOTION ? 0 : 1.05,
                        lock: true,
                        force: true,
                        onComplete: () => {
                            void media.offsetHeight;
                            const corrected = Math.max(
                                0,
                                Math.round(
                                    media.getBoundingClientRect().top + window.scrollY - clearance,
                                ),
                            );
                            if (Math.abs(corrected - window.scrollY) > 6) {
                                lenis.scrollTo(corrected, { immediate: true, force: true });
                            }
                        },
                    });
                    return;
                }

                media.scrollIntoView({
                    behavior: REDUCE_MOTION ? "auto" : "smooth",
                    block: "start",
                });
            };

            // Two RAFs: let panel display + focus settle so measure isn't mid-layout.
            requestAnimationFrame(() => {
                requestAnimationFrame(run);
            });
        }

        /**
         * Keep the active filter row in view by scrolling only the list pane.
         * Below the fold → pin to the bottom edge; above → pin to the top.
         * Avoids scrollIntoView, which can drag the page.
         */
        function scrollOptionIntoList(option) {
            if (!option || option.hidden || !list) {
                return;
            }
            const row = option.closest("li") || option;
            const listRect = list.getBoundingClientRect();
            const rowRect = row.getBoundingClientRect();
            const fullyVisible =
                rowRect.top >= listRect.top - 0.5 && rowRect.bottom <= listRect.bottom + 0.5;
            if (fullyVisible) {
                return;
            }

            let delta = 0;
            if (rowRect.bottom > listRect.bottom) {
                delta = rowRect.bottom - listRect.bottom;
            } else if (rowRect.top < listRect.top) {
                delta = rowRect.top - listRect.top;
            }
            if (!delta) {
                return;
            }

            list.scrollTo({
                top: list.scrollTop + delta,
                behavior: REDUCE_MOTION ? "auto" : "smooth",
            });
        }

        function setActive(index, {
            scrollOption = true,
            fromMap = false,
            focusOption = false,
            direction = 0,
            scrollMedia = false,
            useTransition = true,
            durationMs = TRANSITION_MS_DEFAULT,
        } = {}) {
            const option = options.find((el) => Number(el.dataset.placeIndex) === index);
            const panel = panels.find((el) => Number(el.dataset.placeIndex) === index);
            if (!option || !panel) {
                return;
            }

            const apply = () => {
                activeIndex = index;

                options.forEach((el) => {
                    const on = Number(el.dataset.placeIndex) === index;
                    el.classList.toggle("is-active", on);
                    el.setAttribute("aria-selected", on ? "true" : "false");
                    el.tabIndex = on ? 0 : -1;
                });

                panels.forEach((el) => {
                    const on = Number(el.dataset.placeIndex) === index;
                    el.classList.toggle("is-active", on);
                    el.hidden = !on;
                    clearDrag(el.querySelector(".places-stage__media"));
                });
                cancelMediaSlide();

                mountStepper(panel.querySelector(".places-stage__media"));
                updateStepControls();

                if (scrollOption && !option.hidden) {
                    scrollOptionIntoList(option);
                }
                if (focusOption) {
                    option.focus({ preventScroll: true });
                }
                if (scrollMedia) {
                    scrollMediaIntoView(panel.querySelector(".places-stage__media"));
                }

                if (!fromMap) {
                    window.TGDestinationMap?.focusPlace?.(index, { openPopup: false });
                }

                root.dispatchEvent(
                    new CustomEvent("tg:place-change", {
                        bubbles: true,
                        detail: {
                            index,
                            name: option.dataset.placeName || "",
                            lat: Number(option.dataset.placeLat),
                            lng: Number(option.dataset.placeLng),
                            direction,
                        },
                    }),
                );
            };

            if (useTransition && direction !== 0 && index !== activeIndex) {
                runWithTransition(apply, direction, durationMs);
            } else {
                // Instant swap keeps the photo hittable for the next mobile swipe.
                apply();
            }
        }

        /**
         * Arrow/swipe steps remount the stepper (and may change body height). If a
         * control is focused, mobile browsers scroll it back into view — pin Y
         * for a couple of frames while the DOM settles (not for the whole slide).
         */
        function withPinnedScroll(fn) {
            const y = window.scrollY;
            const lenis = window.TGSmoothScroll?.lenis;
            let pinRaf = 0;

            const restore = () => {
                if (lenis) {
                    const current = Number.isFinite(lenis.scroll) ? lenis.scroll : window.scrollY;
                    if (Math.abs(current - y) > 1) {
                        lenis.scrollTo(y, { immediate: true, force: true });
                    }
                    return;
                }
                if (Math.abs(window.scrollY - y) > 1) {
                    window.scrollTo(0, y);
                }
            };

            const stopPinning = () => {
                if (pinRaf) {
                    cancelAnimationFrame(pinRaf);
                    pinRaf = 0;
                }
            };

            const pinUntilSettled = () => {
                restore();
                pinRaf = requestAnimationFrame(pinUntilSettled);
            };

            const result = fn();
            restore();
            pinUntilSettled();

            const release = () => {
                stopPinning();
                restore();
            };

            // Two frames is enough for remount/focus settle; holding for the full
            // media-slide duration fights Lenis and makes browsing feel sticky.
            requestAnimationFrame(() => {
                requestAnimationFrame(release);
            });
            return result;
        }

        function stepBy(delta, { useTransition = true, durationMs = TRANSITION_MS_DEFAULT } = {}) {
            const next = neighborIndex(delta);
            if (next == null || next === activeIndex) {
                return false;
            }
            // Keep page scroll put during swipe / arrow steps so mobile does not jump.
            // Still advance the filter list so the active place stays in view.
            return withPinnedScroll(() => {
                setActive(next, { scrollOption: true, direction: delta, useTransition, durationMs });
                return true;
            });
        }

        function applyFilter(query) {
            const q = String(query || "").trim().toLowerCase();
            let shown = 0;
            options.forEach((el) => {
                const name = (el.dataset.placeName || el.textContent || "").toLowerCase();
                const match = !q || name.includes(q);
                el.hidden = !match;
                el.setAttribute("aria-hidden", match ? "false" : "true");
                // Hide the wrapping <li> so flex gap does not leave empty slots.
                const row = el.closest("li");
                if (row && row.parentElement === list) {
                    row.hidden = !match;
                }
                if (match) {
                    shown += 1;
                }
            });
            if (countEl) {
                countEl.textContent = String(shown);
            }
            if (emptyEl) {
                emptyEl.hidden = shown > 0;
            }
            const activeOpt = options.find((el) => Number(el.dataset.placeIndex) === activeIndex);
            if (activeOpt && activeOpt.hidden) {
                const next = visibleOptions()[0];
                if (next) {
                    setActive(Number(next.dataset.placeIndex), { scrollOption: true });
                }
            } else {
                updateStepControls();
            }
        }

        list.addEventListener("click", (event) => {
            const option = event.target.closest("[data-place-option]");
            if (!option || !list.contains(option) || option.hidden) {
                return;
            }
            // Native focus scrolling keeps the list row in view and fights the
            // intentional scroll-up to the stage photo (especially on mobile).
            option.focus({ preventScroll: true });
            setActive(Number(option.dataset.placeIndex), {
                scrollOption: false,
                scrollMedia: true,
            });
        });

        list.addEventListener("keydown", (event) => {
            const visible = visibleOptions();
            if (visible.length === 0) {
                return;
            }
            const currentPos = visible.findIndex((el) => Number(el.dataset.placeIndex) === activeIndex);
            let nextPos = currentPos < 0 ? 0 : currentPos;

            if (event.key === "ArrowDown" || event.key === "j") {
                event.preventDefault();
                nextPos = Math.min(visible.length - 1, currentPos + 1);
            } else if (event.key === "ArrowUp" || event.key === "k") {
                event.preventDefault();
                nextPos = Math.max(0, currentPos - 1);
            } else if (event.key === "Home") {
                event.preventDefault();
                nextPos = 0;
            } else if (event.key === "End") {
                event.preventDefault();
                nextPos = visible.length - 1;
            } else {
                return;
            }

            setActive(Number(visible[nextPos].dataset.placeIndex), {
                scrollOption: true,
                focusOption: true,
            });
        });

        let arrowPressBtn = null;

        function setArrowPressed(btn, pressed) {
            if (!btn) {
                return;
            }
            if (pressed) {
                if (btn.disabled) {
                    return;
                }
                if (arrowPressBtn && arrowPressBtn !== btn) {
                    arrowPressBtn.classList.remove("is-pressed");
                }
                arrowPressBtn = btn;
                btn.classList.add("is-pressed");
                void btn.offsetWidth;
                return;
            }
            btn.classList.remove("is-pressed");
            if (arrowPressBtn === btn) {
                arrowPressBtn = null;
            }
        }

        /**
         * Press = brass while held; release clears immediately (no post-click flash).
         * Touch: preventDefault blocks focus-scroll; step on pointerup (no click).
         * Mouse/keyboard: step on click; :active / is-pressed cover the press.
         */
        function bindArrowButton(btn, delta) {
            if (!btn) {
                return;
            }
            let touchArmed = false;
            let ignoreClickUntil = 0;

            btn.addEventListener(
                "pointerdown",
                (event) => {
                    if (btn.disabled) {
                        return;
                    }
                    if (event.pointerType === "mouse" && event.button !== 0) {
                        return;
                    }
                    setArrowPressed(btn, true);
                    if (event.pointerType === "mouse") {
                        return;
                    }
                    touchArmed = true;
                    // Block focus (and its scroll-into-view) on touch.
                    event.preventDefault();
                },
                { passive: false },
            );

            const clearPress = () => setArrowPressed(btn, false);

            btn.addEventListener("pointerup", (event) => {
                clearPress();
                if (!touchArmed || event.pointerType === "mouse") {
                    return;
                }
                touchArmed = false;
                if (btn.disabled) {
                    return;
                }
                ignoreClickUntil = performance.now() + 400;
                stepBy(delta, { durationMs: TRANSITION_MS_CLICK });
            });

            btn.addEventListener("pointercancel", () => {
                touchArmed = false;
                clearPress();
            });

            btn.addEventListener("pointerleave", (event) => {
                // Mouse drag-off: drop highlight like a normal button.
                if (event.pointerType === "mouse") {
                    clearPress();
                }
            });

            btn.addEventListener("click", (event) => {
                if (performance.now() < ignoreClickUntil) {
                    event.preventDefault();
                    return;
                }
                // No flash here — press/release already handled highlight.
                event.currentTarget?.blur();
                stepBy(delta, { durationMs: TRANSITION_MS_CLICK });
            });
        }

        bindArrowButton(prevBtn, -1);
        bindArrowButton(nextBtn, 1);

        stage.addEventListener("keydown", (event) => {
            if (event.target.closest("[data-places-list], input, textarea, select, a, button:not([data-places-prev]):not([data-places-next])")) {
                return;
            }
            if (event.key === "ArrowLeft") {
                event.preventDefault();
                stepBy(-1, { durationMs: TRANSITION_MS_CLICK });
            } else if (event.key === "ArrowRight") {
                event.preventDefault();
                stepBy(1, { durationMs: TRANSITION_MS_CLICK });
            }
        });

        function lockHorizontalSwipe(pointerId) {
            if (!swipe || swipe.captured) {
                return;
            }
            swipe.captured = true;
            swipe.media.classList.add("is-dragging", "is-swiping-lock");
            try {
                swipe.media.setPointerCapture(pointerId);
            } catch (_) {
                /* ignore */
            }
        }

        function updateSwipeFromPoint(clientX, clientY, pointerId, cancelableEvent) {
            if (!swipe) {
                return;
            }

            const dx = clientX - swipe.startX;
            const dy = clientY - swipe.startY;
            swipe.prevX = swipe.lastX;
            swipe.prevT = swipe.lastT;
            swipe.dx = dx;
            swipe.dy = dy;
            swipe.lastX = clientX;
            swipe.lastT = performance.now();

            if (!swipe.axis) {
                if (Math.abs(dx) < SWIPE_AXIS_PX && Math.abs(dy) < SWIPE_AXIS_PX) {
                    return;
                }
                swipe.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
                if (swipe.axis === "x") {
                    lockHorizontalSwipe(pointerId);
                }
            }

            if (swipe.axis !== "x") {
                return;
            }

            // Stop browser back-swipe / page overscroll from claiming the gesture.
            if (cancelableEvent?.cancelable) {
                cancelableEvent.preventDefault();
            }
            swipe.media.style.setProperty("--places-drag-x", `${dragOffset(dx)}px`);
            updatePeek(swipe.media, dx);
        }

        stage.addEventListener("pointerdown", (event) => {
            if (event.pointerType === "mouse" && event.button !== 0) {
                return;
            }
            if (event.target.closest("a, button, input, textarea, select, label")) {
                return;
            }
            const media = event.target.closest(".places-stage__media");
            if (!media || !stage.contains(media) || visibleOptions().length < 2) {
                return;
            }

            // Drop any leftover slide so the active photo is hittable immediately.
            cancelMediaSlide();

            swipe = {
                pointerId: event.pointerId,
                media,
                startX: event.clientX,
                startY: event.clientY,
                startT: performance.now(),
                lastX: event.clientX,
                lastT: performance.now(),
                prevX: event.clientX,
                prevT: performance.now(),
                dx: 0,
                dy: 0,
                axis: null,
                captured: false,
            };
        });

        stage.addEventListener(
            "pointermove",
            (event) => {
                if (!swipe || event.pointerId !== swipe.pointerId) {
                    return;
                }
                updateSwipeFromPoint(event.clientX, event.clientY, event.pointerId, event);
            },
            { passive: false },
        );

        // iOS/Android often need a non-passive touchmove to block page swipe.
        stage.addEventListener(
            "touchmove",
            (event) => {
                if (!swipe || event.touches.length !== 1) {
                    return;
                }
                const touch = event.touches[0];
                updateSwipeFromPoint(touch.clientX, touch.clientY, swipe.pointerId, event);
            },
            { passive: false, capture: true },
        );

        function endSwipe(event, cancelled) {
            if (!swipe || event.pointerId !== swipe.pointerId) {
                return;
            }

            const { media, dx, axis, lastX, startX, startT, prevX, prevT, lastT } = swipe;
            const elapsed = Math.max(16, performance.now() - startT);
            const avgVelocity = (lastX - startX) / elapsed;
            const flickElapsed = Math.max(8, lastT - prevT);
            const flickVelocity = (lastX - prevX) / flickElapsed;
            const velocity =
                Math.abs(flickVelocity) > Math.abs(avgVelocity) ? flickVelocity : avgVelocity;
            swipe = null;

            if (cancelled || axis !== "x") {
                bounceDrag(media);
                return;
            }

            const shouldStep =
                Math.abs(dx) >= SWIPE_THRESHOLD || Math.abs(velocity) >= SWIPE_VELOCITY;
            if (!shouldStep) {
                bounceDrag(media);
                return;
            }

            const delta = dx < 0 || velocity < 0 ? 1 : -1;
            const durationMs = transitionMsFromSwipe(
                dx,
                avgVelocity,
                flickVelocity,
                media.offsetWidth,
            );
            // Reset live drag/peek so the media slide captures the same
            // clean current→neighbor motion as an arrow click.
            clearDrag(media);
            if (!stepBy(delta, { useTransition: true, durationMs })) {
                bounceDrag(media);
            }
        }

        stage.addEventListener("pointerup", (event) => endSwipe(event, false));
        stage.addEventListener("pointercancel", (event) => endSwipe(event, true));

        root.querySelectorAll("[data-place-show-map]").forEach((btn) => {
            btn.addEventListener("click", () => {
                const index = Number(btn.closest("[data-place-panel]")?.dataset.placeIndex ?? activeIndex);
                const atlas = document.getElementById("atlas");
                const reveal = () => {
                    window.TGDestinationMap?.focusPlace?.(index, { openPopup: true });
                };

                // Native scrollIntoView fights Lenis and can scroll the wrong
                // direction on the first click; use the shared Lenis helper.
                if (atlas && window.TGSmoothScroll?.scrollToElement) {
                    window.TGSmoothScroll.scrollToElement(atlas, {
                        duration: REDUCE_MOTION ? 0 : 1.2,
                        onComplete: reveal,
                    });
                    return;
                }

                atlas?.scrollIntoView({
                    behavior: REDUCE_MOTION ? "auto" : "smooth",
                    block: "start",
                });
                reveal();
            });
        });

        if (filterInput) {
            filterInput.addEventListener("input", () => applyFilter(filterInput.value));
        }

        // Ensure single-panel state matches markup without hiding content before enhance.
        panels.forEach((el) => {
            const on = Number(el.dataset.placeIndex) === activeIndex;
            el.hidden = !on;
            el.classList.toggle("is-active", on);
        });
        setActive(activeIndex, { scrollOption: false });

        return {
            selectByIndex(index, opts = {}) {
                setActive(Number(index), opts);
            },
            getActiveIndex() {
                return activeIndex;
            },
            stepBy,
        };
    }

    function boot() {
        const root = document.querySelector("[data-places-explorer]");
        const api = initExplorer(root);
        window.TGDestinationPlaces = {
            selectByIndex(index, opts) {
                api?.selectByIndex(index, opts);
            },
            getActiveIndex() {
                return api?.getActiveIndex?.() ?? 0;
            },
            stepBy(delta, opts) {
                api?.stepBy?.(delta, opts);
            },
        };
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot);
    } else {
        boot();
    }
})();
