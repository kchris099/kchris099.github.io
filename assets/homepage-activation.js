(function () {
    const DEV_PORT = 8765;
    const SYNC_CHANNEL_NAME = "tg-country-activation";

    let mapInstance = null;
    let apiBase = null;
    let syncChannel = null;

    const readTG = () => window.TG || {};

    const normalizeCode = (code) => String(code || "").toUpperCase();

    const escapeHtml = (value) => String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

    const findGuideByCountryName = (countryName) => {
        const guides = Object.values(readTG().allCountryGuides || {});
        return guides.find((guide) => guide.name === countryName) || null;
    };

    const apiCandidates = () => {
        const bases = [];
        if (location.origin && location.origin !== "null") {
            bases.push(`${location.origin}/__dev__/api/countries`);
        }
        bases.push(`http://127.0.0.1:${DEV_PORT}/__dev__/api/countries`);
        bases.push(`http://localhost:${DEV_PORT}/__dev__/api/countries`);
        return bases;
    };

    const probeApi = async () => {
        for (const base of apiCandidates()) {
            try {
                const response = await fetch(`${base}/TH`, { cache: "no-store", mode: "cors" });
                if (response.ok) {
                    apiBase = base;
                    return true;
                }
            } catch (_error) {
                // Try the next candidate.
            }
        }
        return false;
    };

    const writeActivation = async (iso2, active) => {
        if (!apiBase) {
            const hasApi = await probeApi();
            if (!hasApi) {
                throw new Error("no api");
            }
        }
        const response = await fetch(`${apiBase}/${normalizeCode(iso2)}`, {
            method: "POST",
            mode: "cors",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ active }),
        });
        if (!response.ok) {
            let message = `write failed (${response.status})`;
            try {
                const payload = await response.json();
                if (payload && typeof payload.error === "string" && payload.error) {
                    message = payload.error;
                }
            } catch (_error) {
                // Ignore malformed error bodies.
            }
            throw new Error(message);
        }
        const payload = await response.json();
        return Boolean(payload.active);
    };

    const broadcastActivation = (iso2, active) => {
        if (!syncChannel) {
            return;
        }
        syncChannel.postMessage({ iso2: normalizeCode(iso2), active });
    };

    const MAP_MARKER_STYLE = {
        active: {
            initial: { fill: "#00F0FF", stroke: "#060B19", strokeWidth: 1.5, r: 4 },
            hover: { fill: "#0070FF", stroke: "#060B19", strokeWidth: 1.5, r: 6 },
        },
        inactive: {
            initial: { fill: "#15234B", stroke: "#475569", strokeWidth: 1.5, r: 4 },
            hover: { fill: "#1E336B", stroke: "#64748b", strokeWidth: 1.5, r: 5 },
        },
    };

    // Markers sit outside #jvm-regions-group, so r stays screen-fixed unless we scale it.
    const MARKER_ZOOM_R_INITIAL_MAX = 14;
    const MARKER_ZOOM_R_HOVER_MAX = 16;

    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

    // Must match TG/assets/world.js inset + Miller central meridian used at build time.
    const WORLD_MAP_INSET = {
        width: 900,
        height: 440.70631074413296,
        bbox: [
            { x: -20004297.151525836, y: -12671671.123330014 },
            { x: 20026572.39474939, y: 6930392.025135122 },
        ],
    };
    const WORLD_MAP_CENTRAL_MERIDIAN = 11.5;
    const MILLER_RADIUS = 6381372;

    const latLngToMapCoords = (lat, lng) => {
        const radians = Math.PI / 180;
        const projectedX = MILLER_RADIUS * (lng - WORLD_MAP_CENTRAL_MERIDIAN) * radians;
        const projectedY =
            (-MILLER_RADIUS * Math.log(Math.tan((45 + 0.4 * lat) * radians))) / 0.8;
        const [{ x: west, y: north }, { x: east, y: south }] = WORLD_MAP_INSET.bbox;
        const mapX = ((projectedX - west) / (east - west)) * WORLD_MAP_INSET.width;
        const mapY = ((projectedY - north) / (south - north)) * WORLD_MAP_INSET.height;
        return [mapX, mapY];
    };

    let mapMarkerEntries = [];
    let mapMarkerCount = 0;

    window.TGActivation = {
        registerMap(map, markerEntries) {
            mapInstance = map;
            mapMarkerEntries = markerEntries || this.buildMapMarkerEntries();
            mapMarkerCount = mapMarkerEntries.length;
            this.applyDefaultWorldMapView(map);
        },

        getMapMarkerEntry(index) {
            return mapMarkerEntries[index] || null;
        },

        resolveRegionName(countryName, travelData) {
            const regions = travelData || readTG().travelData || {};
            for (const [continent, countries] of Object.entries(regions)) {
                if (countries.includes(countryName)) {
                    return continent;
                }
            }
            return "Unknown Region";
        },

        buildMapMarkerEntries() {
            const tg = readTG();
            const markerMap = tg.mapCountryMarkers || {};
            const allGuides = tg.allCountryGuides || {};
            const available = tg.availableGuides || {};
            return Object.entries(markerMap)
                .filter(([code]) => allGuides[code])
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([code, marker]) => ({
                    code,
                    name: marker.name,
                    coords: marker.coords,
                    active: Boolean(available[code]),
                }));
        },

        buildMapMarkerPayloads(entries) {
            return (entries || mapMarkerEntries).map(({ name, coords, active }) => ({
                name,
                coords: latLngToMapCoords(coords[0], coords[1]),
                style: active ? MAP_MARKER_STYLE.active : MAP_MARKER_STYLE.inactive,
            }));
        },

        getMapMarkerDefaultStyle() {
            return MAP_MARKER_STYLE.active;
        },

        syncMapMarkerSizesForZoom() {
            if (!mapInstance?._markers || !mapInstance._baseScale) {
                return;
            }

            const factor = mapInstance.scale / mapInstance._baseScale;
            Object.values(mapInstance._markers).forEach((marker) => {
                const shape = marker?.element?.shape;
                const style = shape?.style;
                if (!shape || !style?.initial) {
                    return;
                }

                const element = marker.element;
                if (element._tgBaseInitialR == null) {
                    element._tgBaseInitialR = Number(style.initial.r) || 4;
                    element._tgBaseHoverR = Number(style.hover?.r) || element._tgBaseInitialR;
                }

                const nextInitial = clamp(
                    element._tgBaseInitialR * factor,
                    element._tgBaseInitialR,
                    MARKER_ZOOM_R_INITIAL_MAX,
                );
                const nextHover = clamp(
                    element._tgBaseHoverR * factor,
                    element._tgBaseHoverR,
                    MARKER_ZOOM_R_HOVER_MAX,
                );

                style.initial.r = nextInitial;
                if (style.hover) {
                    style.hover.r = nextHover;
                }
                if (typeof shape.updateStyle === "function") {
                    shape.updateStyle();
                } else if (shape.node) {
                    shape.node.setAttribute("r", String(shape.isHovered ? nextHover : nextInitial));
                }
            });
        },

        applyDefaultWorldMapView(map) {
            if (!map?.regions?.RU?.element?.shape) {
                return;
            }

            const bbox = map.regions.RU.element.shape.getBBox();
            const easternEdge = bbox.x + bbox.width;
            const zoomFactor = 1.14;
            const nextScale = map.scale * zoomFactor;
            const viewportWidth = map._width / nextScale;
            map.scale = nextScale;
            map.transX = viewportWidth - easternEdge;
            map._applyTransform();
        },

        getIso2ForCountry(countryName, countryCodes) {
            const allGuides = readTG().allCountryGuides || {};
            for (const [code, guide] of Object.entries(allGuides)) {
                if (guide.name === countryName) {
                    return code;
                }
            }
            const flagCode = (countryCodes || {})[countryName];
            return flagCode ? normalizeCode(flagCode) : "XX";
        },

        getCountryStatus(code) {
            const iso2 = normalizeCode(code);
            const allGuides = readTG().allCountryGuides || {};
            if (!allGuides[iso2]) {
                return "unavailable";
            }
            return (readTG().availableGuides || {})[iso2] ? "active" : "inactive";
        },

        isCountryVisuallyActive(countryName) {
            const code = (readTG().countryCodes || {})[countryName];
            if (!code) {
                return false;
            }
            return this.getCountryStatus(code) === "active";
        },

        isCodeVisuallyActive(code) {
            return this.getCountryStatus(code) === "active";
        },

        getCountryPageUrl(countryName) {
            const guide = findGuideByCountryName(countryName);
            return guide ? guide.url : null;
        },

        getGuideByCode(code) {
            return (readTG().allCountryGuides || {})[normalizeCode(code)] || null;
        },

        setCountryActiveInMemory(iso2, active) {
            const code = normalizeCode(iso2);
            const tg = readTG();
            const allGuides = tg.allCountryGuides || {};
            const guide = allGuides[code];
            if (!guide) {
                return false;
            }
            if (!tg.availableGuides) {
                tg.availableGuides = {};
            }
            if (active) {
                tg.availableGuides[code] = guide;
            } else {
                delete tg.availableGuides[code];
            }
            return true;
        },

        updateLegendCounts() {
            const tg = readTG();
            const activeCodes = Object.keys(tg.availableGuides || {});
            const counts = tg.countryDestinationCounts || {};
            const countriesEl = document.getElementById("legend-countries-count");
            const destinationsEl = document.getElementById("legend-destinations-count");
            if (countriesEl) {
                countriesEl.textContent = String(activeCodes.length);
            }
            if (destinationsEl) {
                const destinationTotal = activeCodes.reduce(
                    (sum, code) => sum + (counts[code] || 0),
                    0,
                );
                destinationsEl.textContent = String(destinationTotal);
            }
        },

        renderStatusDot(iso2, countryName) {
            const status = this.getCountryStatus(iso2);
            const toggleable = status !== "unavailable";
            const labels = {
                active: `${countryName} is active on the homepage (click to hide)`,
                inactive: `${countryName} is hidden on the homepage (click to show)`,
                unavailable: `${countryName} has no built guide yet`,
            };
            const disabled = toggleable ? "" : " disabled";
            const toggleClass = toggleable ? " country-status-dot--toggleable" : "";
            return `
                <button
                    type="button"
                    class="country-status-dot country-status-dot--${status}${toggleClass}"
                    data-iso2="${normalizeCode(iso2)}"
                    data-country-name="${countryName}"
                    aria-label="${labels[status]}"
                    title="${labels[status]}"
                    ${disabled}
                ></button>
            `;
        },

        getCountrySortRank(country, countryCodes) {
            const status = this.getCountryStatus(this.getIso2ForCountry(country, countryCodes));
            if (status === "active") {
                return 0;
            }
            if (status === "inactive") {
                return 1;
            }
            return 2;
        },

        countCountriesWithGuides(countries, countryCodes) {
            return countries.filter(
                (country) =>
                    this.getCountryStatus(this.getIso2ForCountry(country, countryCodes)) !== "unavailable",
            ).length;
        },

        sortCountriesForDisplay(countries, countryCodes) {
            return [...countries].sort((a, b) => {
                const rankA = this.getCountrySortRank(a, countryCodes);
                const rankB = this.getCountrySortRank(b, countryCodes);
                if (rankA !== rankB) {
                    return rankA - rankB;
                }
                return a.localeCompare(b);
            });
        },

        renderCountryListItem(country, continent, countryCodes) {
            const active = this.isCountryVisuallyActive(country);
            const url = this.getCountryPageUrl(country);
            const flagCode = (countryCodes || {})[country] || "xx";
            const iso2 = this.getIso2ForCountry(country, countryCodes);
            const statusDot = this.renderStatusDot(iso2, country);

            if (url) {
                const tone = active
                    ? "text-slate-300 hover:text-neon-cyan"
                    : "text-slate-500 hover:text-slate-300";
                const imageClass = active ? "shadow-sm" : "opacity-50";
                return `
                    <div class="country-status-row" data-country-name="${country}" data-continent="${continent}">
                        <a href="${url}" class="country-status-link ${tone} group/link">
                            <img src="assets/flags/w20/${flagCode}.png" alt="${country} flag" class="w-5 rounded-[2px] ${imageClass}">
                            <span class="font-medium truncate">${country}</span>
                        </a>
                        ${statusDot}
                    </div>
                `;
            }

            return `
                <div class="country-status-row" data-country-name="${country}" data-continent="${continent}">
                    <div class="country-status-label text-slate-500 cursor-not-allowed">
                        <img src="assets/flags/w20/${flagCode}.png" alt="${country} flag" class="w-5 rounded-[2px] opacity-50">
                        <span class="font-medium truncate">${country}</span>
                    </div>
                    ${statusDot}
                </div>
            `;
        },

        renderSearchResult(result, countryCodes) {
            const active = this.isCountryVisuallyActive(result.name);
            const url = this.getCountryPageUrl(result.name);
            const code = (countryCodes || {})[result.name] || "xx";
            const name = escapeHtml(result.name);
            const continent = escapeHtml(result.continent);

            if (url) {
                return `<a href="${escapeHtml(url)}" class="search-result${active ? "" : " search-result--inactive"}"><span class="search-result__content"><span class="search-result__title">${name}</span><span class="search-result__meta">${continent}</span></span><img src="assets/flags/w20/${escapeHtml(code)}.png" alt="" class="search-result__media"></a>`;
            }

            return `<div class="search-result search-result--unavailable"><span class="search-result__content"><span class="search-result__title">${name}</span><span class="search-result__meta">${continent}</span></span><img src="assets/flags/w20/${escapeHtml(code)}.png" alt="" class="search-result__media"></div>`;
        },

        getTooltipHtml(officialName, regionName, code, countryCodes) {
            const flagUrl = `assets/flags/w40/${String(code).toLowerCase()}.png`;
            const hasGuide = Boolean(this.getGuideByCode(code));
            const active = this.isCodeVisuallyActive(code);
            const headerHtml = `
                <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
                    <img src="${flagUrl}" style="width:24px; border-radius:2px; box-shadow:0 1px 3px rgba(0,0,0,0.5);" alt="flag">
                    <b style="color:white; font-size:16px;">${officialName}</b>
                </div>
                <div style="font-size:12px; color:#94a3b8; margin-bottom:6px;">
                    <i class="ph ph-globe-hemisphere-west"></i> Region: ${regionName}
                </div>
            `;

            if (active) {
                return `${headerHtml}<div style="font-size:13px;color:#00F0FF;margin-top:4px;font-weight:600;display:flex;align-items:center;gap:4px;"><i class="ph ph-book-open"></i> Click to view guides &rarr;</div>`;
            }
            if (hasGuide) {
                return `${headerHtml}<div style="font-size:13px;color:#94a3b8;margin-top:4px;display:flex;align-items:center;gap:4px;"><i class="ph ph-eye"></i> Preview guide</div>`;
            }
            return `${headerHtml}<div style="font-size:13px;color:#64748b;margin-top:4px;display:flex;align-items:center;gap:4px;"><i class="ph ph-clock"></i> Guides coming soon</div>`;
        },

        refreshDropdownLists(countryCodes) {
            const travelData = readTG().travelData || {};
            document.querySelectorAll("ul[data-continent]").forEach((list) => {
                const continent = list.dataset.continent;
                const countries = travelData[continent];
                if (!continent || !countries) {
                    return;
                }
                const sorted = this.sortCountriesForDisplay(countries, countryCodes);
                list.innerHTML = sorted
                    .map(
                        (country) =>
                            `<li class="country-status-item">${this.renderCountryListItem(country, continent, countryCodes)}</li>`,
                    )
                    .join("");
            });
        },

        refreshOpenSearch() {
            const input = document.getElementById("search-input");
            if (input && input.value.trim()) {
                input.dispatchEvent(new Event("input", { bubbles: true }));
            }
        },

        refreshMapMarkers() {
            if (!mapInstance || typeof mapInstance.addMarkers !== "function") {
                return;
            }

            const entries = this.buildMapMarkerEntries();
            const payloads = this.buildMapMarkerPayloads(entries);

            if (mapMarkerCount > 0 && typeof mapInstance.removeMarkers === "function") {
                mapInstance.removeMarkers(
                    Array.from({ length: mapMarkerCount }, (_, index) => index),
                );
            }

            if (payloads.length) {
                mapInstance.addMarkers(payloads);
            }

            mapMarkerEntries = entries;
            mapMarkerCount = payloads.length;
            this.syncMapMarkerSizesForZoom();
        },

        refreshMap() {
            if (!mapInstance) {
                return;
            }
            const activeCodes = Object.keys(readTG().availableGuides || {});
            if (typeof mapInstance.setSelectedRegions === "function") {
                mapInstance.setSelectedRegions(activeCodes);
            }
            this.refreshMapMarkers();
        },

        applyActivationChange(iso2, active, countryCodes) {
            this.setCountryActiveInMemory(iso2, active);
            this.updateLegendCounts();
            if (countryCodes) {
                this.refreshDropdownLists(countryCodes);
            }
            this.refreshOpenSearch();
            this.refreshMap();
        },

        async toggleCountry(iso2, countryCodes) {
            const code = normalizeCode(iso2);
            if (this.getCountryStatus(code) === "unavailable") {
                return false;
            }

            const previousActive = this.getCountryStatus(code) === "active";
            const nextActive = !previousActive;
            this.applyActivationChange(code, nextActive, countryCodes);

            try {
                const confirmed = await writeActivation(code, nextActive);
                if (confirmed !== nextActive) {
                    this.applyActivationChange(code, confirmed, countryCodes);
                }
                broadcastActivation(code, confirmed);
                return confirmed;
            } catch (error) {
                this.applyActivationChange(code, previousActive, countryCodes);
                throw error;
            }
        },

        bindActivationControls(root, countryCodes) {
            // Capture phase: dropdown bodies call stopPropagation(), which would
            // otherwise prevent this delegated handler from seeing the click.
            const scope = root || document;
            scope.addEventListener("click", async (event) => {
                const button = event.target.closest(".country-status-dot--toggleable");
                if (!button || button.disabled || button.classList.contains("country-status-dot--busy")) {
                    return;
                }
                event.preventDefault();
                event.stopPropagation();

                button.classList.add("country-status-dot--busy");
                try {
                    await this.toggleCountry(button.dataset.iso2, countryCodes);
                } catch (error) {
                    button.classList.add("country-status-dot--error");
                    window.setTimeout(() => button.classList.remove("country-status-dot--error"), 900);
                    const message = error instanceof Error ? error.message : "toggle failed";
                    if (message.includes("no api")) {
                        button.title = "Start serve-dev.bat to toggle countries locally.";
                    } else {
                        button.title = message;
                    }
                    console.warn(`Country toggle failed for ${button.dataset.iso2}:`, message);
                } finally {
                    button.classList.remove("country-status-dot--busy");
                }
            }, true);
        },

        initSyncListener(countryCodes) {
            if (typeof BroadcastChannel === "undefined") {
                return;
            }
            if (!syncChannel) {
                syncChannel = new BroadcastChannel(SYNC_CHANNEL_NAME);
            }
            if (this._syncListenerBound) {
                return;
            }
            this._syncListenerBound = true;
            syncChannel.addEventListener("message", (event) => {
                const iso2 = normalizeCode(event.data?.iso2);
                if (!iso2 || typeof event.data?.active !== "boolean") {
                    return;
                }
                this.applyActivationChange(iso2, event.data.active, countryCodes);
            });
        },
    };

    if (typeof BroadcastChannel !== "undefined") {
        syncChannel = new BroadcastChannel(SYNC_CHANNEL_NAME);
    }
})();
