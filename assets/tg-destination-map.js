(function initTGDestinationMap() {
    /**
     * Mobile Leaflet guard for destination pages (see country-page-map-playbook.txt §7.8).
     * Call after map.fitBounds: TGDestinationMap.bindMobileScrollGuard(map, 'map');
     */
    const MOBILE_QUERY = "(max-width: 767px)";

    function fitToLocations(map, locations, destinationCenter, mapContext = {}) {
        if (!map || !Array.isArray(locations) || locations.length === 0) {
            if (map && destinationCenter) map.setView(destinationCenter, 14);
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
    }

    function bindMobileScrollGuard(map, frameId) {
        const frame = document.getElementById(frameId);
        if (!map || !frame) {
            return;
        }

        const mq = window.matchMedia(MOBILE_QUERY);
        let active = false;

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

        frame.addEventListener(
            "click",
            (event) => {
                if (!mq.matches || active) {
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
    }

    window.TGDestinationMap = {
        bindMobileScrollGuard,
        fitToLocations,
    };
})();
