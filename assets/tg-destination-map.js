(function initTGDestinationMap() {
    /**
     * Mobile Leaflet guard for destination pages (see country-page-map-playbook.txt §7.8).
     * Call after map.fitBounds: TGDestinationMap.bindMobileScrollGuard(map, 'map');
     */
    const MOBILE_QUERY = "(max-width: 767px)";

    function fitToLocations(map, locations, destinationCenter, mapContext = {}) {
        if (!map || !Array.isArray(locations) || locations.length === 0) {
            if (map && destinationCenter) map.setView(destinationCenter, 14);
            if (map) attachViewResetControl(map, locations, destinationCenter, mapContext);
            return;
        }

        let bounds = L.latLngBounds(locations.map((location) => [location.lat, location.lng]));
        const ne = bounds.getNorthEast();
        const sw = bounds.getSouthWest();
        const latSpan = ne.lat - sw.lat;
        const lngSpan = ne.lng - sw.lng;
        const maxSpan = Math.max(latSpan, lngSpan);
        const isDegenerate = latSpan < 1e-9 && lngSpan < 1e-9;
        const markerCenterLat = (ne.lat + sw.lat) / 2;
        const markerCenterLng = (ne.lng + sw.lng) / 2;

        if (isDegenerate) {
            const frameSpan = mapContext.compactRegion ? 0.026 : 0.045;
            bounds = L.latLngBounds(
                [destinationCenter[0] - frameSpan / 2, destinationCenter[1] - frameSpan / 2],
                [destinationCenter[0] + frameSpan / 2, destinationCenter[1] + frameSpan / 2],
            );
        } else if ((mapContext.nationalPark || mapContext.scenicCorridor) && locations.length >= 3) {
            const expand = maxSpan < 0.12 ? 1.15 : 1.1;
            const halfLat = latSpan / 2 * expand;
            const halfLng = lngSpan / 2 * expand;
            bounds = L.latLngBounds(
                [markerCenterLat - halfLat, markerCenterLng - halfLng],
                [markerCenterLat + halfLat, markerCenterLng + halfLng],
            );
        } else if (mapContext.largeRegion && locations.length >= 3) {
            const latReach = Math.max(mapContext.maxCenterLat, latSpan / 2) * 1.45;
            const lngReach = Math.max(mapContext.maxCenterLng, lngSpan / 2) * 1.45;
            bounds = L.latLngBounds(
                [destinationCenter[0] - latReach, destinationCenter[1] - lngReach],
                [destinationCenter[0] + latReach, destinationCenter[1] + lngReach],
            );
        } else if (mapContext.islandCity && locations.length >= 3) {
            const halfLat = latSpan / 2 * 1.1;
            const halfLng = lngSpan / 2 * 1.1;
            bounds = L.latLngBounds(
                [markerCenterLat - halfLat, markerCenterLng - halfLng],
                [markerCenterLat + halfLat, markerCenterLng + halfLng],
            );
        } else if (locations.length === 2 && maxSpan < 0.02) {
            const frameSpan = Math.max(maxSpan * 4, 0.006);
            bounds = L.latLngBounds(
                [markerCenterLat - frameSpan / 2, markerCenterLng - frameSpan / 2],
                [markerCenterLat + frameSpan / 2, markerCenterLng + frameSpan / 2],
            );
        }

        const fitOptions = {};
        if ((mapContext.nationalPark || mapContext.scenicCorridor) && locations.length >= 3) {
            fitOptions.padding = maxSpan < 0.12 ? [24, 24] : (maxSpan < 0.5 ? [24, 24] : [28, 28]);
            fitOptions.maxZoom = maxSpan < 0.12 ? 14 : (maxSpan < 0.5 ? 10 : 9);
        } else if (mapContext.largeRegion && locations.length >= 3) {
            fitOptions.padding = [40, 40];
            fitOptions.maxZoom = 8;
        } else if (mapContext.islandCity && locations.length >= 3) {
            fitOptions.padding = [24, 24];
        } else if (mapContext.denseUrban) {
            fitOptions.padding = [18, 18];
        } else if (mapContext.spreadUrban) {
            fitOptions.padding = [20, 20];
        } else if (locations.length >= 3 && maxSpan >= 0.02) {
            fitOptions.padding = maxSpan >= 0.08 ? [20, 20] : [30, 30];
        } else if (locations.length === 2 && maxSpan < 0.02) {
            fitOptions.padding = [12, 12];
            fitOptions.maxZoom = 16;
        } else if (isDegenerate || locations.length === 1) {
            fitOptions.padding = mapContext.compactRegion ? [16, 16] : [36, 36];
            if (isDegenerate || maxSpan < 0.015) fitOptions.maxZoom = mapContext.compactRegion ? 15 : 14;
        } else {
            fitOptions.padding = [50, 50];
        }

        map.fitBounds(bounds, fitOptions);
        attachViewResetControl(map, locations, destinationCenter, mapContext);
    }

    /**
     * Leaflet's +/- controls use <a href="#">. Neutralize the hash so a missed
     * preventDefault cannot jump the page to the top (common on mobile).
     */
    function hardenZoomControlAnchors(map) {
        const container = map?.zoomControl?.getContainer?.();
        if (!container || map._tgZoomAnchorsHardened) {
            return;
        }
        map._tgZoomAnchorsHardened = true;
        container.querySelectorAll("a[href='#']").forEach((anchor) => {
            anchor.addEventListener(
                "click",
                (event) => {
                    event.preventDefault();
                },
                true,
            );
        });
    }

    /**
     * Append a turnaround (↺) control under Leaflet's +/- zoom buttons.
     * Restores the page default view via fitToLocations.
     */
    function attachViewResetControl(map, locations, destinationCenter, mapContext = {}) {
        if (!map) {
            return;
        }

        map._tgResetView = { locations, destinationCenter, mapContext };

        if (map._tgResetControlAttached) {
            return;
        }

        const container = map.zoomControl?.getContainer?.();
        if (!container || typeof L === "undefined") {
            return;
        }

        map._tgResetControlAttached = true;
        hardenZoomControlAnchors(map);

        // Use <button>, not <a href="#"> — hash links scroll to top when the
        // mobile scroll-guard stops propagation before Leaflet can preventDefault.
        const button = L.DomUtil.create("button", "leaflet-control-zoom-reset", container);
        button.type = "button";
        button.title = "Reset map view";
        button.setAttribute("aria-label", "Reset map view");
        button.innerHTML = '<span aria-hidden="true">&#8634;</span>';

        L.DomEvent.disableClickPropagation(button);
        L.DomEvent.on(button, "click", L.DomEvent.stop).on(button, "click", () => {
            const args = map._tgResetView || {};
            fitToLocations(map, args.locations, args.destinationCenter, args.mapContext || {});
        });
    }

    function bindMobileScrollGuard(map, frameId) {
        const frame = document.getElementById(frameId);
        if (!map || !frame) {
            return;
        }

        const mq = window.matchMedia(MOBILE_QUERY);
        let active = false;

        const isMapControlTarget = (target) =>
            target instanceof Element &&
            Boolean(target.closest(".leaflet-control, .leaflet-control-zoom-reset"));

        const lock = () => {
            map.dragging.disable();
            map.touchZoom.disable();
            map.doubleClickZoom.disable();
            frame.classList.add("tg-map-frame--touch-locked");
            frame.classList.remove("tg-map-frame--active");
            active = false;
        };

        const unlock = () => {
            map.dragging.enable();
            map.touchZoom.enable();
            map.doubleClickZoom.enable();
            frame.classList.remove("tg-map-frame--touch-locked");
            frame.classList.add("tg-map-frame--active");
            active = true;
        };

        const applyMode = () => {
            if (mq.matches) {
                lock();
            } else {
                map.dragging.enable();
                map.touchZoom.enable();
                map.doubleClickZoom.enable();
                frame.classList.remove("tg-map-frame--touch-locked", "tg-map-frame--active");
                active = false;
            }
        };

        // Capture-phase: while locked, a bare stopPropagation on control taps
        // blocked Leaflet's preventDefault, so <a href="#"> scrolled to top.
        frame.addEventListener(
            "click",
            (event) => {
                if (!mq.matches) {
                    return;
                }

                if (isMapControlTarget(event.target)) {
                    event.preventDefault();
                    if (!active) {
                        unlock();
                    }
                    // Do not stopPropagation — let +/- / reset handlers run.
                    return;
                }

                if (active) {
                    return;
                }
                event.stopPropagation();
                unlock();
            },
            true,
        );

        document.addEventListener("click", (event) => {
            if (!mq.matches || !active || frame.contains(event.target)) {
                return;
            }
            lock();
        });

        mq.addEventListener("change", applyMode);
        applyMode();
        hardenZoomControlAnchors(map);
    }

    let registeredMap = null;
    let registeredMarkers = [];

    function registerMarkers(map, markers) {
        registeredMap = map || null;
        registeredMarkers = Array.isArray(markers) ? markers : [];
    }

    function focusPlace(index, { openPopup = false } = {}) {
        const marker = registeredMarkers[Number(index)];
        if (!registeredMap || !marker) {
            return;
        }

        const latLng = marker.getLatLng();
        const placeIndex = Number(index);

        const highlight = () => {
            registeredMarkers.forEach((entry, i) => {
                const el = entry.getElement?.();
                if (!el) {
                    return;
                }
                el.classList.toggle("tg-map-marker--active", i === placeIndex);
            });
        };

        const reveal = () => {
            registeredMap.invalidateSize?.();
            highlight();
            if (openPopup) {
                marker.openPopup();
            }
        };

        // Opening a popup mid-pan often loses to the animation (or keeps the
        // previous marker's popup). Wait for moveend; if already centered,
        // moveend may not fire so reveal immediately.
        const center = registeredMap.getCenter();
        const alreadyCentered =
            Math.abs(center.lat - latLng.lat) < 1e-6 &&
            Math.abs(center.lng - latLng.lng) < 1e-6;

        if (openPopup && !alreadyCentered) {
            registeredMap.once("moveend", reveal);
            registeredMap.panTo(latLng, { animate: true });
            return;
        }

        if (!alreadyCentered) {
            registeredMap.panTo(latLng, { animate: true });
        }
        reveal();
    }

    /**
     * Subtle hero parallax on [data-destination-hero-image].
     *
     * The hero stacks above the atlas (z-index 30 over 4) so its mask can fade
     * over that section. Continuing to mutate transform while the atlas is on
     * screen recomposites that stacked layer every Lenis frame and reads as
     * sections flickering up/down. Freeze as soon as the atlas enters the
     * viewport (with hysteresis), not only after the hero has fully left.
     */
    function bindHeroParallax() {
        const heroImage = document.querySelector("[data-destination-hero-image]");
        const heroSection = heroImage?.closest(".destination-hero");
        const atlas = document.querySelector(".destination-atlas");
        const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        if (!heroImage || !heroSection || reduceMotion) {
            return;
        }

        let framePending = false;
        let lastOffset = null;
        let frozen = false;
        const FREEZE_ENTER = 12;
        const FREEZE_EXIT = 48;

        const readScrollY = () => {
            const lenis = window.TGSmoothScroll?.lenis;
            if (lenis && Number.isFinite(lenis.scroll)) {
                return lenis.scroll;
            }
            return window.scrollY || window.pageYOffset || 0;
        };

        const shouldFreeze = () => {
            const heroBottom = heroSection.getBoundingClientRect().bottom;
            if (heroBottom <= 0) {
                return true;
            }
            if (!atlas) {
                return false;
            }
            const atlasTop = atlas.getBoundingClientRect().top;
            const viewH = window.innerHeight;
            // Hysteresis: freeze earlier than we unfreeze so the boundary does
            // not chatter when Lenis eases near the atlas edge.
            if (frozen) {
                return atlasTop < viewH + FREEZE_EXIT;
            }
            return atlasTop < viewH - FREEZE_ENTER;
        };

        const updateHeroPosition = () => {
            framePending = false;
            if (shouldFreeze()) {
                if (!frozen) {
                    frozen = true;
                    heroImage.style.willChange = "auto";
                    heroSection.classList.add("is-parallax-frozen");
                }
                return;
            }
            if (frozen) {
                frozen = false;
                heroSection.classList.remove("is-parallax-frozen");
            }
            const offset = Math.round(
                Math.min(Math.max(readScrollY(), 0), window.innerHeight * 1.15) * 0.075,
            );
            if (lastOffset !== null && offset === lastOffset) {
                return;
            }
            lastOffset = offset;
            heroImage.style.transform = `translate3d(0, ${offset}px, 0) scale(1.055)`;
        };

        const onScroll = () => {
            if (!framePending) {
                framePending = true;
                window.requestAnimationFrame(updateHeroPosition);
            }
        };

        const lenis = window.TGSmoothScroll?.lenis;
        if (lenis && typeof lenis.on === "function") {
            lenis.on("scroll", onScroll);
        } else {
            window.addEventListener("scroll", onScroll, { passive: true });
        }
        updateHeroPosition();
    }

    window.TGDestinationMap = {
        attachViewResetControl,
        bindHeroParallax,
        bindMobileScrollGuard,
        fitToLocations,
        registerMarkers,
        focusPlace,
    };
})();
