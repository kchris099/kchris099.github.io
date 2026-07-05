(function () {
    const SVG_NS = "http://www.w3.org/2000/svg";
    const MARKER_RADIUS_BASE = 6;
    const MARKER_RADIUS_FOCUS_SCALE = 1.2;
    const MARKER_HIT_RADIUS_MIN = 22;
    const TOUCH_PAN_THRESHOLD = 10;
    const GESTURE_SUPPRESS_MS = 350;
    const MARKER_LOC_BASE = 10;
    const MARKER_LOC_MAX = 40;
    const ZOOM_MAX = 8;
    const ZOOM_STEP = 1.35;
    const MOBILE_INSET_MAX_WIDTH = 767;

    const markerRadiusForLocations = (locations) => {
        const count = Number(locations) || 0;
        if (count >= MARKER_LOC_MAX) {
            return MARKER_RADIUS_BASE * 2;
        }
        if (count <= MARKER_LOC_BASE) {
            return MARKER_RADIUS_BASE;
        }
        const t = (count - MARKER_LOC_BASE) / (MARKER_LOC_MAX - MARKER_LOC_BASE);
        return MARKER_RADIUS_BASE * (1 + t);
    };

    let mapInstance = null;

    const readActivation = () => window.TGDestinationActivation || null;

    const escapeHtml = (value) =>
        String(value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");

    const countActiveGuides = (activation, names) =>
        names.filter((name) => activation.hasGuide(name) && activation.isActive(name)).length;

    const countListedGuides = (activation, names) =>
        names.filter((name) => activation.hasGuide(name)).length;

    const projectPoint = (lat, lng, bounds, frame, pad = 0) => {
        const innerW = frame.width - 2 * pad;
        const innerH = frame.height - 2 * pad;
        const x = frame.x + pad + ((lng - bounds.west) / (bounds.east - bounds.west)) * innerW;
        const y = frame.y + pad + ((bounds.north - lat) / (bounds.north - bounds.south)) * innerH;
        return [x, y];
    };

    const MARKER_GLOW_FILTER_ACTIVE = "country-map-marker-glow-active";
    const MARKER_GLOW_FILTER_INACTIVE = "country-map-marker-glow-inactive";

    const appendMarkerGlowFilters = (defs) => {
        const addFilter = (id, color, layers) => {
            const filter = document.createElementNS(SVG_NS, "filter");
            filter.setAttribute("id", id);
            filter.setAttribute("filterUnits", "objectBoundingBox");
            filter.setAttribute("primitiveUnits", "objectBoundingBox");
            filter.setAttribute("x", "-1.25");
            filter.setAttribute("y", "-1.25");
            filter.setAttribute("width", "3.5");
            filter.setAttribute("height", "3.5");
            filter.setAttribute("color-interpolation-filters", "sRGB");

            const mergeInputs = [];
            layers.forEach(({ stdDev, opacity }, index) => {
                const shadow = document.createElementNS(SVG_NS, "feDropShadow");
                shadow.setAttribute("in", "SourceGraphic");
                shadow.setAttribute("dx", "0");
                shadow.setAttribute("dy", "0");
                shadow.setAttribute("stdDeviation", String(stdDev));
                shadow.setAttribute("flood-color", color);
                shadow.setAttribute("flood-opacity", String(opacity));
                shadow.setAttribute("result", `shadow${index}`);
                filter.appendChild(shadow);
                mergeInputs.push(`shadow${index}`);
            });

            const merge = document.createElementNS(SVG_NS, "feMerge");
            mergeInputs.forEach((input) => {
                const node = document.createElementNS(SVG_NS, "feMergeNode");
                node.setAttribute("in", input);
                merge.appendChild(node);
            });
            const sourceNode = document.createElementNS(SVG_NS, "feMergeNode");
            sourceNode.setAttribute("in", "SourceGraphic");
            merge.appendChild(sourceNode);
            filter.appendChild(merge);
            defs.appendChild(filter);
        };

        // Match .country-map-legend-dot box-shadow (10px + 20px blurs)
        addFilter(MARKER_GLOW_FILTER_ACTIVE, "#22c55e", [
            { stdDev: 0.42, opacity: 0.95 },
            { stdDev: 0.83, opacity: 0.55 },
        ]);
        addFilter(MARKER_GLOW_FILTER_INACTIVE, "#ef4444", [
            { stdDev: 0.42, opacity: 0.9 },
            { stdDev: 0.83, opacity: 0.5 },
        ]);
    };

    const markerGlowFilterUrl = (active) =>
        `url(#${active ? MARKER_GLOW_FILTER_ACTIVE : MARKER_GLOW_FILTER_INACTIVE})`;

    const normalizeCountryCode = (code) => String(code || "").toUpperCase();

    const getCountryGuideByCode = (code) => {
        const normalized = normalizeCountryCode(code);
        if (!normalized) {
            return null;
        }
        return (
            window.TGActivation?.getGuideByCode?.(normalized) ||
            window.TG?.allCountryGuides?.[normalized] ||
            window.TGCountryGuides?.[normalized] ||
            null
        );
    };

    const resolveMapData = async (options) => {
        if (options.mapData) {
            return options.mapData;
        }
        const registry = window.TGCountryMapRegistry || {};
        if (registry[options.mapId]) {
            return registry[options.mapId];
        }
        const mapUrl =
            options.mapDataUrl ||
            `${options.assetsBase || "../../assets/"}maps/${options.mapId}.json`;
        const response = await fetch(mapUrl, { cache: "force-cache" });
        if (!response.ok) {
            throw new Error(`map fetch failed (${response.status})`);
        }
        return response.json();
    };

    const normalizeMapData = (mapData) => {
        if (mapData.main) {
            return mapData;
        }
        return {
            viewBox: mapData.viewBox,
            main: {
                frame: { x: 0, y: 0, width: 800, height: 500 },
                bounds: mapData.bounds,
                regions: Object.fromEntries(
                    Object.entries(mapData.regions || {}).map(([name, value]) => [
                        name,
                        typeof value === "string" ? value : value.path,
                    ]),
                ),
            },
            insets: [],
            neighbors: mapData.neighbors || [],
            destinations: mapData.destinations || {},
        };
    };

    class CountryMap {
        constructor(options) {
            this.options = options;
            this.root = document.querySelector(options.selector);
            this.activation = options.activation || readActivation();
            this.mapData = null;
            this.shell = null;
            this.state = {
                hoveredRegion: null,
                hoveredDestination: null,
                hoveredCountry: null,
            };
            this.neighborByCode = new Map();
            this.markerElements = new Map();
            this.overlay = null;
            this.overlayFrame = null;
            this.lastPointer = null;
            this.svg = null;
            this.viewport = null;
            this.mainMarkersLayer = null;
            this.insetMarkersLayer = null;
            this.insetScreenGroup = null;
            this.insetDrawer = null;
            this.insetDrawerGroup = null;
            this.insetDrawerMarkersLayer = null;
            this.insetToggle = null;
            this.insetDrawerOpen = false;
            this.insetMobileQuery = null;
            this.boundInsetMobileChange = null;
            this.markerTouchQuery = null;
            this.boundMarkerTouchChange = null;
            this.insetResizeObserver = null;
            this.zoomState = { scale: 1, x: 0, y: 0 };
            this.defaultZoomState = { scale: 1, x: 0, y: 0 };
            this.zoomControls = null;
            this.panState = null;
            this.activePointers = new Map();
            this.pinchSnapshot = null;
            this.pointerStarts = new Map();
            this.suppressClickUntil = 0;
            this.boundPointerDown = this.handlePointerDown.bind(this);
            this.boundPointerMove = this.handlePointerMove.bind(this);
            this.boundPointerUp = this.handlePointerUp.bind(this);
            this.boundPointerCancel = this.handlePointerCancel.bind(this);
            this.boundRegionOver = this.handleRegionOver.bind(this);
            this.boundRegionOut = this.handleRegionOut.bind(this);
            this.boundMarkerOver = this.handleMarkerOver.bind(this);
            this.boundMarkerOut = this.handleMarkerOut.bind(this);
            this.boundNeighborOver = this.handleNeighborOver.bind(this);
            this.boundNeighborOut = this.handleNeighborOut.bind(this);
            this.boundKeyDown = this.handleKeyDown.bind(this);
        }

        async init() {
            if (!this.root || !this.options.hasRegions) {
                return false;
            }

            try {
                this.mapData = normalizeMapData(await resolveMapData(this.options));
                this.defaultZoomState = this.resolveDefaultZoomState();
                this.zoomState = { ...this.defaultZoomState };
            } catch (error) {
                this.renderFallback();
                console.warn("Country map unavailable:", error);
                return false;
            }

            this.render();
            mapInstance = this;
            return true;
        }

        renderFallback() {
            this.root.innerHTML = `
                <div class="country-map-fallback" role="status">
                    <div>
                        <p class="text-lg font-semibold text-white mb-2">Interactive map is temporarily unavailable.</p>
                        <p class="text-slate-400">Browse regions above or use search to open a guide.</p>
                    </div>
                </div>
            `;
        }

        getDestinationsForRegion(regionName) {
            return this.options.countryData[regionName] || [];
        }

        findRegionForDestination(name) {
            for (const [region, destinations] of Object.entries(this.options.countryData)) {
                if (destinations.includes(name)) {
                    return region;
                }
            }
            return null;
        }

        regionHasActiveGuides(regionName) {
            if (!this.activation) {
                return true;
            }
            const destinations = this.getDestinationsForRegion(regionName);
            if (destinations.length === 0) {
                return false;
            }
            return countActiveGuides(this.activation, destinations) > 0;
        }

        resolveDestinationPlane(dest) {
            const mainPad = this.mapData.main.pad ?? 12;
            if (dest.plane === "main" || !dest.plane) {
                return {
                    bounds: this.mapData.main.bounds,
                    frame: this.mapData.main.frame,
                    pad: mainPad,
                };
            }
            const insetId = String(dest.plane).replace("inset:", "");
            const inset = (this.mapData.insets || []).find((entry) => entry.id === insetId);
            if (!inset) {
                return {
                    bounds: this.mapData.main.bounds,
                    frame: this.mapData.main.frame,
                    pad: mainPad,
                };
            }
            return { bounds: inset.bounds, frame: inset.frame, pad: 8 };
        }

        getMarkerRadius(meta, focused = false, marker = null) {
            const radius = markerRadiusForLocations(meta.locations);
            const base = focused ? radius * MARKER_RADIUS_FOCUS_SCALE : radius;
            const markerRadiusScale = Number(this.mapData?.markerRadiusScale) || 1;
            if (marker?.dataset.coordSpace === "root") {
                return base * (this.defaultZoomState.scale || 1) * markerRadiusScale;
            }
            return base * markerRadiusScale;
        }

        useExpandedMarkerHit() {
            if (typeof window === "undefined" || !window.matchMedia) {
                return false;
            }
            return (
                window.matchMedia("(pointer: coarse)").matches ||
                window.matchMedia(`(max-width: ${MOBILE_INSET_MAX_WIDTH}px)`).matches
            );
        }

        getMarkerHitRadius(meta, focused = false, marker = null) {
            const visualRadius = this.getMarkerRadius(meta, focused, marker);
            if (!this.useExpandedMarkerHit()) {
                return visualRadius;
            }
            return Math.max(visualRadius, MARKER_HIT_RADIUS_MIN);
        }

        getPanMoveThreshold() {
            return this.useExpandedMarkerHit() ? TOUCH_PAN_THRESHOLD : 3;
        }

        syncMainMarkerPositions() {
            if (!this.viewport) {
                return;
            }
            const { scale, x, y } = this.zoomState;
            this.markerElements.forEach((marker) => {
                if (marker.dataset.coordSpace !== "root") {
                    return;
                }
                const localX = Number(marker.dataset.localX);
                const localY = Number(marker.dataset.localY);
                if (!Number.isFinite(localX) || !Number.isFinite(localY)) {
                    return;
                }
                const screenX = scale * localX + x;
                const screenY = scale * localY + y;
                marker.querySelectorAll(".country-map-marker__dot, .country-map-marker__hit").forEach((node) => {
                    node.setAttribute("cx", String(screenX));
                    node.setAttribute("cy", String(screenY));
                });
            });
        }

        isInsetPlane(plane) {
            return Boolean(plane && plane !== "main" && String(plane).startsWith("inset:"));
        }

        applyMarkerGlowFilter(dot, active) {
            if (dot) {
                dot.setAttribute("filter", markerGlowFilterUrl(active));
            }
        }

        setMarkerRadius(marker, meta, focused = false) {
            const dot = marker?.querySelector(".country-map-marker__dot");
            const hit = marker?.querySelector(".country-map-marker__hit");
            const visualRadius = this.getMarkerRadius(meta, focused, marker);
            const hitRadius = this.getMarkerHitRadius(meta, focused, marker);
            if (dot) {
                dot.setAttribute("r", String(visualRadius));
            }
            if (hit) {
                hit.setAttribute("r", String(hitRadius));
            }
        }

        syncAllMarkerGeometry() {
            this.markerElements.forEach((marker, name) => {
                const meta = this.getMarkerMeta(name);
                if (!meta) {
                    return;
                }
                const focused = marker.classList.contains("country-map-marker--focused");
                this.setMarkerRadius(marker, meta, focused);
            });
        }

        setupMarkerTouchListener() {
            if (typeof window === "undefined" || !window.matchMedia) {
                return;
            }
            this.markerTouchQuery = window.matchMedia("(pointer: coarse)");
            this.boundMarkerTouchChange = () => this.syncAllMarkerGeometry();
            if (typeof this.markerTouchQuery.addEventListener === "function") {
                this.markerTouchQuery.addEventListener("change", this.boundMarkerTouchChange);
            } else if (typeof this.markerTouchQuery.addListener === "function") {
                this.markerTouchQuery.addListener(this.boundMarkerTouchChange);
            }
        }

        navigateToMarkerMeta(meta) {
            if (!meta?.url || Date.now() < this.suppressClickUntil) {
                return false;
            }
            window.location.href = meta.url;
            return true;
        }

        resolveDefaultZoomState() {
            const view = this.mapData?.main?.defaultView;
            if (!view) {
                return { scale: 1, x: 0, y: 0 };
            }
            return {
                scale: Number(view.scale) || 1,
                x: Number(view.x) || 0,
                y: Number(view.y) || 0,
            };
        }

        getMinZoomScale() {
            return this.defaultZoomState.scale;
        }

        flagUrlForCode(code) {
            const base = this.options.assetsBase || "../../assets/";
            return `${base}flags/w40/${String(code).toLowerCase()}.png`;
        }

        resolveCountryGuide(country) {
            const guide = getCountryGuideByCode(country.code);
            const url = guide?.url || null;
            const hasGuide = Boolean(url);
            const activation = window.TGActivation;
            const active = activation
                ? activation.isCodeVisuallyActive(country.code)
                : Boolean(guide);
            return {
                url,
                hasGuide,
                active,
                continent:
                    guide?.continent ||
                    (country.continent && country.continent !== "Unknown"
                        ? country.continent
                        : ""),
            };
        }

        buildCountryTooltipHtml(country) {
            const { url, hasGuide, active, continent } = this.resolveCountryGuide(country);
            const flagUrl = this.flagUrlForCode(country.code);
            const headerHtml = `
                <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
                    <img src="${escapeHtml(flagUrl)}" style="width:24px; border-radius:2px; box-shadow:0 1px 3px rgba(0,0,0,0.5);" alt="">
                    <b style="color:white; font-size:16px; font-weight:700; line-height:1.2;">${escapeHtml(country.name)}</b>
                </div>
                <div style="font-size:12px; color:#94a3b8; margin-bottom:6px; display:flex; align-items:center; gap:4px;">
                    <i class="ph ph-globe-hemisphere-west" aria-hidden="true"></i>
                    <span>Region: ${escapeHtml(continent || "")}</span>
                </div>
            `;
            if (active && url) {
                return `${headerHtml}<div style="font-size:13px;color:#00F0FF;margin-top:4px;font-weight:600;display:flex;align-items:center;gap:4px;"><i class="ph ph-book-open" aria-hidden="true"></i> Click to view guides &rarr;</div>`;
            }
            if (hasGuide) {
                return `${headerHtml}<div style="font-size:13px;color:#94a3b8;margin-top:4px;display:flex;align-items:center;gap:4px;"><i class="ph ph-eye" aria-hidden="true"></i> Preview guide</div>`;
            }
            return `${headerHtml}<div style="font-size:13px;color:#64748b;margin-top:4px;display:flex;align-items:center;gap:4px;"><i class="ph ph-clock" aria-hidden="true"></i> Guides coming soon</div>`;
        }

        buildRegionTooltipHtml(regionName, total, active) {
            const flagUrl = this.options.flagPath;
            return `
                <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
                    <img src="${escapeHtml(flagUrl)}" style="width:24px; border-radius:2px; box-shadow:0 1px 3px rgba(0,0,0,0.5);" alt="">
                    <b style="color:white; font-size:16px; font-weight:700; line-height:1.2;">${escapeHtml(regionName)}</b>
                </div>
                <div style="font-size:12px; color:#94a3b8; margin-bottom:6px; display:flex; align-items:center; gap:4px;">
                    <i class="ph ph-map-trifold" aria-hidden="true"></i>
                    <span>${total} destination${total === 1 ? "" : "s"}</span>
                </div>
                <div style="font-size:12px; color:#94a3b8; margin-bottom:0; display:flex; align-items:center; gap:4px;">
                    <i class="ph ph-book-open" aria-hidden="true"></i>
                    <span>${active} active guide${active === 1 ? "" : "s"}</span>
                </div>
            `;
        }

        buildDestinationTooltipHtml(meta) {
            const flagUrl = this.options.flagPath;
            const cta = meta.url
                ? meta.active
                    ? `<div style="font-size:13px;color:#00F0FF;margin-top:4px;font-weight:600;display:flex;align-items:center;gap:4px;"><i class="ph ph-book-open" aria-hidden="true"></i> Click to view guide &rarr;</div>`
                    : `<div style="font-size:13px;color:#94a3b8;margin-top:4px;display:flex;align-items:center;gap:4px;"><i class="ph ph-eye" aria-hidden="true"></i> Preview guide</div>`
                : `<div style="font-size:13px;color:#64748b;margin-top:4px;display:flex;align-items:center;gap:4px;"><i class="ph ph-clock" aria-hidden="true"></i> Guide coming soon</div>`;
            return `
                <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
                    <img src="${escapeHtml(flagUrl)}" style="width:24px; border-radius:2px; box-shadow:0 1px 3px rgba(0,0,0,0.5);" alt="">
                    <b style="color:white; font-size:16px; font-weight:700; line-height:1.2;">${escapeHtml(meta.name)}</b>
                </div>
                <div style="font-size:12px; color:#94a3b8; margin-bottom:6px; display:flex; align-items:center; gap:4px;">
                    <i class="ph ph-globe-hemisphere-west" aria-hidden="true"></i>
                    <span>Region: ${escapeHtml(meta.region || "")}</span>
                </div>
                <div style="font-size:12px; color:#94a3b8; margin-bottom:0; display:flex; align-items:center; gap:4px;">
                    <i class="ph ph-map-pin" aria-hidden="true"></i>
                    <span>${meta.locations} guide location${meta.locations === 1 ? "" : "s"}</span>
                </div>
                ${cta}
            `;
        }

        getHostRegion() {
            const regions = ["europe", "asia", "africa", "north-america", "south-america", "oceania"];
            const parts = window.location.pathname.split("/").filter(Boolean);
            return parts.find((part) => regions.includes(part)) || "europe";
        }

        resolveCountryPageUrl(url) {
            if (!url) {
                return null;
            }
            if (/^(https?:|\/|\.\.)/.test(url)) {
                return url;
            }
            const match = url.match(/^([a-z-]+)\/(.+)$/);
            if (!match) {
                return url;
            }
            const [, targetRegion, rest] = match;
            if (targetRegion === this.getHostRegion()) {
                return `../${rest}`;
            }
            return `../../${targetRegion}/${rest}`;
        }

        createNeighborPath(country) {
            const path = document.createElementNS(SVG_NS, "path");
            path.setAttribute("d", country.path);
            path.setAttribute("class", "country-map-neighbor");
            path.dataset.countryCode = country.code;
            const { url, hasGuide } = this.resolveCountryGuide(country);
            if (hasGuide) {
                path.setAttribute("role", "button");
                path.setAttribute("aria-label", `${country.name} country`);
                path.addEventListener("mousedown", (event) => {
                    event.preventDefault();
                });
                path.addEventListener("click", (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (Date.now() < this.suppressClickUntil) {
                        return;
                    }
                    const href = this.resolveCountryPageUrl(url);
                    if (href) {
                        window.location.href = href;
                    }
                });
            } else {
                path.setAttribute("aria-label", `${country.name}`);
                path.classList.add("country-map-neighbor--static");
            }
            return path;
        }

        getMarkerMeta(name) {
            const mapDest = this.mapData.destinations[name];
            if (!mapDest) {
                return null;
            }
            const activation = this.activation;
            return {
                name,
                region: this.findRegionForDestination(name),
                lat: mapDest.lat,
                lng: mapDest.lng,
                plane: mapDest.plane || "main",
                locations: mapDest.locations || 0,
                url: activation ? activation.guideUrl(name) : null,
                hasGuide: activation ? activation.hasGuide(name) : true,
                active: activation ? activation.isActive(name) : true,
            };
        }

        createRegionPath(regionName, pathData) {
            const path = document.createElementNS(SVG_NS, "path");
            path.setAttribute("d", pathData);
            path.setAttribute("class", "country-map-region");
            path.setAttribute("data-region", regionName);
            path.setAttribute("fill-rule", "evenodd");
            path.setAttribute("tabindex", "0");
            path.setAttribute("role", "button");
            path.setAttribute("aria-label", `${regionName} region`);
            path.addEventListener("mousedown", (event) => {
                event.preventDefault();
            });
            return path;
        }

        hasMapInsets() {
            return (this.mapData?.insets || []).length > 0;
        }

        isMobileInsetLayout() {
            if (typeof window === "undefined" || !window.matchMedia) {
                return false;
            }
            return window.matchMedia(`(max-width: ${MOBILE_INSET_MAX_WIDTH}px)`).matches;
        }

        computeInsetViewBox(pad = 8) {
            const frames = (this.mapData.insets || []).map((inset) => inset.frame);
            const minX = Math.min(...frames.map((frame) => frame.x)) - pad;
            const minY = Math.min(...frames.map((frame) => frame.y)) - pad;
            const maxX = Math.max(...frames.map((frame) => frame.x + frame.width)) + pad;
            const maxY = Math.max(...frames.map((frame) => frame.y + frame.height)) + pad;
            return `${minX} ${minY} ${maxX - minX} ${maxY - minY}`;
        }

        buildInsetsLayer() {
            const insetsLayer = document.createElementNS(SVG_NS, "g");
            insetsLayer.setAttribute("class", "country-map-insets");
            insetsLayer.addEventListener("mouseover", this.boundRegionOver);
            insetsLayer.addEventListener("mouseout", this.boundRegionOut);
            (this.mapData.insets || []).forEach((inset) => {
                insetsLayer.appendChild(this.renderInset(inset));
            });
            return insetsLayer;
        }

        buildInsetMarkersLayer(coordSpace = "inset") {
            const layer = document.createElementNS(SVG_NS, "g");
            layer.setAttribute("class", "country-map-markers country-map-markers--inset");
            layer.addEventListener("mouseover", this.boundMarkerOver);
            layer.addEventListener("mouseout", this.boundMarkerOut);
            Object.keys(this.mapData.destinations).forEach((name) => {
                const meta = this.getMarkerMeta(name);
                if (!meta || !meta.hasGuide || !this.isInsetPlane(meta.plane)) {
                    return;
                }
                const plane = this.resolveDestinationPlane(meta);
                const [x, y] = projectPoint(meta.lat, meta.lng, plane.bounds, plane.frame, plane.pad);
                layer.appendChild(this.createMarker(meta, x, y, coordSpace));
            });
            return layer;
        }

        createInsetDrawer() {
            if (!this.hasMapInsets()) {
                return null;
            }

            const drawer = document.createElement("div");
            drawer.className = "country-map-inset-drawer";
            drawer.id = "country-map-inset-drawer";
            drawer.hidden = true;
            drawer.setAttribute("aria-hidden", "true");

            const backdrop = document.createElement("div");
            backdrop.className = "country-map-inset-drawer__backdrop";
            backdrop.addEventListener("click", () => this.setInsetDrawerOpen(false));

            const panel = document.createElement("div");
            panel.className = "country-map-inset-drawer__panel";

            const title = document.createElement("div");
            title.className = "country-map-inset-drawer__title";
            title.textContent = "Additional regions";

            const svg = document.createElementNS(SVG_NS, "svg");
            svg.setAttribute("class", "country-map-inset-drawer__svg");
            svg.setAttribute("viewBox", this.computeInsetViewBox());
            svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
            svg.setAttribute("role", "img");
            svg.setAttribute("aria-label", "Island and territory regions");

            const defs = document.createElementNS(SVG_NS, "defs");
            appendMarkerGlowFilters(defs);
            svg.appendChild(defs);

            const drawerGroup = document.createElementNS(SVG_NS, "g");
            drawerGroup.setAttribute("class", "country-map-inset-drawer__content");
            drawerGroup.appendChild(this.buildInsetsLayer());
            this.insetDrawerMarkersLayer = this.buildInsetMarkersLayer("inset-drawer");
            drawerGroup.appendChild(this.insetDrawerMarkersLayer);
            svg.appendChild(drawerGroup);

            panel.appendChild(title);
            panel.appendChild(svg);
            drawer.appendChild(backdrop);
            drawer.appendChild(panel);

            this.insetDrawer = drawer;
            this.insetDrawerGroup = drawerGroup;
            return drawer;
        }

        createInsetToggle() {
            if (!this.hasMapInsets()) {
                return null;
            }

            const button = document.createElement("button");
            button.type = "button";
            button.className = "country-map-inset-toggle";
            button.hidden = true;
            button.setAttribute("aria-label", "Show additional regions");
            button.setAttribute("aria-expanded", "false");
            button.setAttribute("aria-controls", "country-map-inset-drawer");
            button.innerHTML =
                '<span class="country-map-inset-toggle__icon" aria-hidden="true">\u2039</span>';
            button.addEventListener("click", (event) => {
                event.preventDefault();
                event.stopPropagation();
                this.setInsetDrawerOpen(!this.insetDrawerOpen);
            });
            this.insetToggle = button;
            return button;
        }

        resolveInsetCoordSpace() {
            return this.isMobileInsetLayout() ? "inset-drawer" : "inset";
        }

        syncInsetMarkerMount(mobile) {
            [...this.markerElements.entries()].forEach(([name, marker]) => {
                const coordSpace = marker.dataset.coordSpace;
                if (coordSpace === "inset" || coordSpace === "inset-drawer") {
                    this.markerElements.delete(name);
                }
            });

            const activeLayer = mobile ? this.insetDrawerMarkersLayer : this.insetMarkersLayer;
            activeLayer?.querySelectorAll(".country-map-marker[data-destination]").forEach((marker) => {
                this.markerElements.set(marker.dataset.destination, marker);
            });
        }

        setInsetDrawerOpen(open) {
            if (!this.insetDrawer || !this.isMobileInsetLayout()) {
                return;
            }
            this.insetDrawerOpen = open;
            this.insetDrawer.classList.toggle("country-map-inset-drawer--open", open);
            this.insetDrawer.setAttribute("aria-hidden", open ? "false" : "true");
            if (this.insetToggle) {
                this.insetToggle.setAttribute("aria-expanded", open ? "true" : "false");
                this.insetToggle.setAttribute(
                    "aria-label",
                    open ? "Hide additional regions" : "Show additional regions",
                );
                const icon = this.insetToggle.querySelector(".country-map-inset-toggle__icon");
                if (icon) {
                    icon.textContent = open ? "\u203A" : "\u2039";
                }
            }
            if (!open) {
                this.state.hoveredDestination = null;
                this.state.hoveredRegion = null;
                this.applyShellState();
                this.hideOverlay();
            }
        }

        syncInsetMobileState() {
            if (!this.hasMapInsets()) {
                return;
            }

            const mobile = this.isMobileInsetLayout();
            if (this.insetScreenGroup) {
                this.insetScreenGroup.classList.toggle(
                    "country-map-insets-screen--mobile-hidden",
                    mobile,
                );
            }
            if (this.insetToggle) {
                this.insetToggle.hidden = !mobile;
            }
            if (this.insetDrawer) {
                this.insetDrawer.hidden = !mobile;
            }
            if (!mobile && this.insetDrawerOpen) {
                this.setInsetDrawerOpen(false);
            }
            this.syncInsetMarkerMount(mobile);
            this.syncAllMarkerGeometry();
            if (!mobile) {
                this.syncInsetScreenScale();
            }
        }

        setupInsetMobileListener() {
            if (!this.hasMapInsets() || typeof window === "undefined" || !window.matchMedia) {
                return;
            }
            this.insetMobileQuery = window.matchMedia(`(max-width: ${MOBILE_INSET_MAX_WIDTH}px)`);
            this.boundInsetMobileChange = () => this.syncInsetMobileState();
            if (typeof this.insetMobileQuery.addEventListener === "function") {
                this.insetMobileQuery.addEventListener("change", this.boundInsetMobileChange);
            } else if (typeof this.insetMobileQuery.addListener === "function") {
                this.insetMobileQuery.addListener(this.boundInsetMobileChange);
            }
        }

        renderInset(inset) {
            const group = document.createElementNS(SVG_NS, "g");
            group.classList.add("country-map-inset");
            group.dataset.insetId = inset.id;

            const frame = document.createElementNS(SVG_NS, "rect");
            frame.setAttribute("x", String(inset.frame.x));
            frame.setAttribute("y", String(inset.frame.y));
            frame.setAttribute("width", String(inset.frame.width));
            frame.setAttribute("height", String(inset.frame.height));
            frame.setAttribute("class", "country-map-inset__frame");
            frame.setAttribute("rx", "6");

            const label = document.createElementNS(SVG_NS, "text");
            label.setAttribute("class", "country-map-inset__label");
            label.setAttribute("x", String(inset.frame.x + inset.frame.width / 2));
            label.setAttribute("y", String(inset.frame.y + 18));
            label.setAttribute("text-anchor", "middle");
            label.textContent = inset.label;

            const path = this.createRegionPath(inset.region, inset.path);
            path.setAttribute("fill-rule", "nonzero");

            group.appendChild(frame);
            group.appendChild(path);
            group.appendChild(label);
            return group;
        }

        render() {
            const { viewBox, main, insets } = this.mapData;

            this.shell = document.createElement("div");
            this.shell.className = "country-map-shell";

            const mapRoot = document.createElement("div");
            mapRoot.className = "country-map-root";
            const strokeWidthScale = Number(this.mapData?.strokeWidthScale) || 1;
            mapRoot.style.setProperty("--country-map-region-stroke", String(3.5 * strokeWidthScale));
            mapRoot.style.setProperty("--country-map-neighbor-stroke", String(2.5 * strokeWidthScale));

            const svg = document.createElementNS(SVG_NS, "svg");
            svg.setAttribute("viewBox", viewBox);
            svg.setAttribute("class", "country-map-svg");
            const align = this.mapData.align || "xMaxYMid meet";
            svg.setAttribute(
                "preserveAspectRatio",
                /\s(meet|slice)$/i.test(align) ? align : `${align} meet`,
            );
            svg.setAttribute("role", "img");
            svg.setAttribute(
                "aria-label",
                `${this.options.countryName} regional map with destination guides`,
            );

            const defs = document.createElementNS(SVG_NS, "defs");
            appendMarkerGlowFilters(defs);
            svg.appendChild(defs);

            const regionsLayer = document.createElementNS(SVG_NS, "g");
            regionsLayer.setAttribute("class", "country-map-regions");
            regionsLayer.addEventListener("mouseover", this.boundRegionOver);
            regionsLayer.addEventListener("mouseout", this.boundRegionOut);

            const neighborsLayer = document.createElementNS(SVG_NS, "g");
            neighborsLayer.setAttribute("class", "country-map-neighbors");
            neighborsLayer.addEventListener("mouseover", this.boundNeighborOver);
            neighborsLayer.addEventListener("mouseout", this.boundNeighborOut);
            (this.mapData.neighbors || []).forEach((country) => {
                this.neighborByCode.set(country.code, country);
                neighborsLayer.appendChild(this.createNeighborPath(country));
            });

            Object.entries(main.regions).forEach(([regionName, pathData]) => {
                regionsLayer.appendChild(this.createRegionPath(regionName, pathData));
            });

            const insetsLayer = this.buildInsetsLayer();

            const mainMarkersLayer = document.createElementNS(SVG_NS, "g");
            mainMarkersLayer.setAttribute("class", "country-map-markers country-map-markers--main");
            mainMarkersLayer.addEventListener("mouseover", this.boundMarkerOver);
            mainMarkersLayer.addEventListener("mouseout", this.boundMarkerOut);

            this.insetMarkersLayer = this.buildInsetMarkersLayer("inset");

            Object.keys(this.mapData.destinations).forEach((name) => {
                const meta = this.getMarkerMeta(name);
                if (!meta || !meta.hasGuide) {
                    return;
                }
                const plane = this.resolveDestinationPlane(meta);
                const [x, y] = projectPoint(meta.lat, meta.lng, plane.bounds, plane.frame, plane.pad);
                const marker = this.createMarker(meta, x, y);
                if (!this.isInsetPlane(meta.plane)) {
                    mainMarkersLayer.appendChild(marker);
                }
            });

            this.mainMarkersLayer = mainMarkersLayer;

            this.viewport = document.createElementNS(SVG_NS, "g");
            this.viewport.setAttribute("class", "country-map-viewport");

            this.viewport.appendChild(neighborsLayer);
            this.viewport.appendChild(regionsLayer);

            const insetScreenGroup = document.createElementNS(SVG_NS, "g");
            insetScreenGroup.setAttribute("class", "country-map-insets-screen");
            insetScreenGroup.appendChild(insetsLayer);
            insetScreenGroup.appendChild(this.insetMarkersLayer);

            svg.appendChild(this.viewport);
            svg.appendChild(mainMarkersLayer);
            svg.appendChild(insetScreenGroup);
            this.svg = svg;
            this.insetScreenGroup = insetScreenGroup;

            this.overlay = document.createElement("div");
            this.overlay.className = "country-map-overlay";
            this.overlay.setAttribute("role", "tooltip");
            this.overlay.setAttribute("aria-hidden", "true");

            this.zoomControls = this.createZoomControls();
            const insetDrawer = this.createInsetDrawer();
            const insetToggle = this.createInsetToggle();

            mapRoot.appendChild(svg);
            mapRoot.appendChild(this.overlay);
            this.shell.appendChild(this.zoomControls);
            if (insetToggle) {
                this.shell.appendChild(insetToggle);
            }
            if (insetDrawer) {
                this.shell.appendChild(insetDrawer);
            }
            this.shell.appendChild(mapRoot);
            this.root.innerHTML = "";
            this.root.appendChild(this.shell);

            this.setupZoom(mapRoot);
            this.setupPointerInteractions(mapRoot);

            mapRoot.addEventListener("pointermove", (event) => {
                this.lastPointer = { x: event.clientX, y: event.clientY };
                if (this.state.hoveredCountry) {
                    this.scheduleOverlayPosition(event.clientX, event.clientY);
                    return;
                }
                this.scheduleOverlayPosition(event.clientX, event.clientY);
            });

            document.addEventListener("keydown", this.boundKeyDown);
            this.applyRegionActiveState();
            this.applyZoomTransform();
            this.syncInsetScreenScale();
            this.setupInsetResizeObserver();
            this.setupInsetMobileListener();
            this.setupMarkerTouchListener();
            this.syncInsetMobileState();
            this.updateLegendCounts();
        }

        setupInsetResizeObserver() {
            if (this.insetResizeObserver) {
                this.insetResizeObserver.disconnect();
                this.insetResizeObserver = null;
            }
            if (!this.insetScreenGroup || !(this.mapData.insets || []).length) {
                return;
            }
            const target = this.root;
            if (!target || typeof ResizeObserver === "undefined") {
                return;
            }
            this.insetResizeObserver = new ResizeObserver(() => {
                this.syncInsetMobileState();
                if (!this.isMobileInsetLayout()) {
                    this.syncInsetScreenScale();
                }
            });
            this.insetResizeObserver.observe(target);
        }

        syncInsetScreenScale() {
            if (!this.svg || !this.insetScreenGroup || this.isMobileInsetLayout()) {
                return;
            }
            const insets = this.mapData.insets || [];
            if (!insets.length) {
                this.insetScreenGroup.removeAttribute("transform");
                return;
            }

            const rect = this.svg.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) {
                return;
            }

            const [, , vbW, vbH] = this.mapData.viewBox.split(/\s+/).map(Number);
            const meetScale = Math.min(rect.width / vbW, rect.height / vbH);
            if (meetScale <= 0) {
                return;
            }

            const counterScale = 1 / meetScale;
            if (Math.abs(counterScale - 1) < 0.001) {
                this.insetScreenGroup.removeAttribute("transform");
                return;
            }

            const frames = insets.map((inset) => inset.frame);
            const pivotX = frames[0].x + frames[0].width / 2;
            const minY = Math.min(...frames.map((frame) => frame.y));
            const maxY = Math.max(...frames.map((frame) => frame.y + frame.height));
            const pivotY = (minY + maxY) / 2;

            this.insetScreenGroup.setAttribute(
                "transform",
                `translate(${pivotX} ${pivotY}) scale(${counterScale}) translate(${-pivotX} ${-pivotY})`,
            );
        }

        getLegendRoot() {
            const selector = this.options.legendSelector;
            if (selector) {
                return document.querySelector(selector);
            }
            return this.root?.closest(".country-map-panel") || this.shell;
        }

        updateLegendCounts() {
            const legendRoot = this.getLegendRoot();
            const activeEl = legendRoot?.querySelector("#country-map-legend-active");
            const inactiveEl = legendRoot?.querySelector("#country-map-legend-inactive");
            if (!activeEl || !inactiveEl) {
                return;
            }
            let active = 0;
            let inactive = 0;
            Object.keys(this.mapData.destinations || {}).forEach((name) => {
                const meta = this.getMarkerMeta(name);
                if (!meta?.hasGuide) {
                    return;
                }
                if (meta.active) {
                    active += 1;
                } else {
                    inactive += 1;
                }
            });
            activeEl.textContent = String(active);
            inactiveEl.textContent = String(inactive);
        }

        createZoomControls() {
            const controls = document.createElement("div");
            controls.className = "country-map-zoom-controls";
            controls.innerHTML = `
                <button type="button" class="country-map-zoom-btn country-map-zoom-btn--in" aria-label="Zoom in">+</button>
                <button type="button" class="country-map-zoom-btn country-map-zoom-btn--out" aria-label="Zoom out">&minus;</button>
            `;
            return controls;
        }

        applyZoomTransform() {
            if (!this.viewport) {
                return;
            }
            const { scale, x, y } = this.zoomState;
            this.viewport.setAttribute(
                "transform",
                `translate(${x} ${y}) scale(${scale})`,
            );
            const mapRoot = this.root?.querySelector(".country-map-root");
            if (mapRoot) {
                mapRoot.classList.toggle("country-map-root--zoomed", this.isZoomedIn());
            }
            this.syncMainMarkerPositions();
            this.syncOverlayPosition();
        }

        clientToSvg(clientX, clientY) {
            if (!this.svg || !this.viewport) {
                return { x: 0, y: 0 };
            }
            const point = this.svg.createSVGPoint();
            point.x = clientX;
            point.y = clientY;
            const matrix = this.viewport.getScreenCTM();
            if (!matrix) {
                return { x: 0, y: 0 };
            }
            return point.matrixTransform(matrix.inverse());
        }

        zoomAt(nextScale, clientX, clientY) {
            const minScale = this.getMinZoomScale();
            const scale = Math.min(ZOOM_MAX, Math.max(minScale, nextScale));
            if (scale <= minScale + 0.001) {
                this.zoomState = { ...this.defaultZoomState };
                this.applyZoomTransform();
                return;
            }
            const point = this.clientToSvg(clientX, clientY);
            const ratio = scale / this.zoomState.scale;
            this.zoomState = {
                scale,
                x: point.x - ratio * (point.x - this.zoomState.x),
                y: point.y - ratio * (point.y - this.zoomState.y),
            };
            this.clampPanState();
            this.applyZoomTransform();
        }

        zoomByFactor(factor, clientX, clientY) {
            const targetScale = this.zoomState.scale * factor;
            if (targetScale <= this.getMinZoomScale() + 0.001) {
                this.zoomAt(this.getMinZoomScale(), clientX, clientY);
                return;
            }
            this.zoomAt(targetScale, clientX, clientY);
        }

        getMapCenterClientPoint(mapRoot) {
            const rect = mapRoot.getBoundingClientRect();
            return {
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2,
            };
        }

        getSvgScreenScale() {
            const matrix = this.svg?.getScreenCTM();
            return matrix ? matrix.a : 1;
        }

        clientDeltaToSvg(deltaX, deltaY) {
            const scale = this.getSvgScreenScale();
            return { x: deltaX / scale, y: deltaY / scale };
        }

        isZoomedIn() {
            return this.zoomState.scale > this.getMinZoomScale() + 0.001;
        }

        clampPanState() {
            if (!this.isZoomedIn()) {
                this.zoomState = { ...this.defaultZoomState };
                return;
            }
            const frame = this.mapData.main.frame;
            const { scale } = this.zoomState;
            const slack = 48;
            const minX = frame.x + frame.width - frame.width * scale - slack;
            const maxX = frame.x + slack;
            const minY = frame.y + frame.height - frame.height * scale - slack;
            const maxY = frame.y + slack;
            this.zoomState.x = Math.min(maxX, Math.max(minX, this.zoomState.x));
            this.zoomState.y = Math.min(maxY, Math.max(minY, this.zoomState.y));
        }

        beginPinchSnapshot() {
            const points = [...this.activePointers.values()];
            if (points.length < 2) {
                return;
            }
            const [a, b] = points;
            const startDistance = Math.hypot(a.x - b.x, a.y - b.y);
            if (startDistance < 12) {
                return;
            }
            this.pinchSnapshot = {
                startDistance,
                startScale: this.zoomState.scale,
                moved: false,
            };
        }

        isUiChromeTarget(target) {
            if (!target || typeof target.closest !== "function") {
                return false;
            }
            return Boolean(target.closest(".country-map-zoom-btn, .country-map-inset-toggle"));
        }

        isPanExemptTarget(target) {
            if (!target || typeof target.closest !== "function") {
                return false;
            }
            return Boolean(
                target.closest(".country-map-insets-screen, .country-map-inset-drawer__panel"),
            );
        }

        suppressMapClick() {
            this.suppressClickUntil = Date.now() + GESTURE_SUPPRESS_MS;
        }

        trackPointerStart(event) {
            this.pointerStarts.set(event.pointerId, {
                x: event.clientX,
                y: event.clientY,
                moved: false,
            });
        }

        markPointerMoved(event) {
            const start = this.pointerStarts.get(event.pointerId);
            if (!start || start.moved) {
                return;
            }
            const dx = event.clientX - start.x;
            const dy = event.clientY - start.y;
            if (Math.hypot(dx, dy) > this.getPanMoveThreshold()) {
                start.moved = true;
            }
        }

        consumePointerTap(event) {
            const start = this.pointerStarts.get(event.pointerId);
            this.pointerStarts.delete(event.pointerId);
            if (!start || start.moved) {
                return false;
            }
            return true;
        }

        handlePointerDown(event) {
            if (this.isUiChromeTarget(event.target)) {
                return;
            }

            this.trackPointerStart(event);
            this.activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

            if (this.activePointers.size === 2) {
                const mapRoot = event.currentTarget;
                if (
                    this.panState?.pointerId &&
                    mapRoot.hasPointerCapture(this.panState.pointerId)
                ) {
                    mapRoot.releasePointerCapture(this.panState.pointerId);
                }
                this.panState = null;
                this.beginPinchSnapshot();
                return;
            }

            if (this.isPanExemptTarget(event.target)) {
                return;
            }

            if (event.button !== 0 || !this.isZoomedIn()) {
                return;
            }

            this.panState = {
                pointerId: event.pointerId,
                startClientX: event.clientX,
                startClientY: event.clientY,
                startX: this.zoomState.x,
                startY: this.zoomState.y,
                moved: false,
            };
        }

        handlePointerMove(event) {
            if (this.activePointers.has(event.pointerId)) {
                this.activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
            }
            this.markPointerMoved(event);

            if (this.pinchSnapshot && this.activePointers.size >= 2) {
                event.preventDefault();
                const points = [...this.activePointers.values()];
                const [a, b] = points;
                const distance = Math.hypot(a.x - b.x, a.y - b.y);
                if (this.pinchSnapshot.startDistance > 0 && distance > 0) {
                    if (Math.abs(distance - this.pinchSnapshot.startDistance) > 8) {
                        this.pinchSnapshot.moved = true;
                    }
                    const nextScale =
                        this.pinchSnapshot.startScale * (distance / this.pinchSnapshot.startDistance);
                    const midX = (a.x + b.x) / 2;
                    const midY = (a.y + b.y) / 2;
                    this.zoomAt(nextScale, midX, midY);
                }
                return;
            }

            if (!this.panState || event.pointerId !== this.panState.pointerId) {
                return;
            }
            const deltaX = event.clientX - this.panState.startClientX;
            const deltaY = event.clientY - this.panState.startClientY;
            const panThreshold = this.getPanMoveThreshold();
            if (!this.panState.moved) {
                if (Math.abs(deltaX) > panThreshold || Math.abs(deltaY) > panThreshold) {
                    this.panState.moved = true;
                    if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
                        event.currentTarget.setPointerCapture(event.pointerId);
                    }
                } else {
                    return;
                }
            }
            event.preventDefault();
            const delta = this.clientDeltaToSvg(deltaX, deltaY);
            this.zoomState.x = this.panState.startX + delta.x;
            this.zoomState.y = this.panState.startY + delta.y;
            this.clampPanState();
            this.applyZoomTransform();
        }

        handlePointerUp(event) {
            const endingPinch = this.pinchSnapshot;
            const panMoved = Boolean(this.panState?.moved);
            const isTap = this.consumePointerTap(event);
            this.activePointers.delete(event.pointerId);
            if (this.activePointers.size < 2) {
                if (endingPinch?.moved) {
                    this.suppressMapClick();
                }
                this.pinchSnapshot = null;
            }

            if (this.panState && event.pointerId === this.panState.pointerId) {
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                    event.currentTarget.releasePointerCapture(event.pointerId);
                }
                if (this.panState.moved) {
                    this.suppressMapClick();
                }
                this.panState = null;
            }

            if (!isTap || panMoved || endingPinch?.moved || Date.now() < this.suppressClickUntil) {
                return;
            }
            if (event.pointerType !== "touch" && event.pointerType !== "pen") {
                return;
            }
            const marker = event.target.closest?.(".country-map-marker[data-destination]");
            if (!marker) {
                return;
            }
            const meta = this.getMarkerMeta(marker.dataset.destination);
            if (meta) {
                this.navigateToMarkerMeta(meta);
            }
        }

        handlePointerCancel(event) {
            this.pointerStarts.delete(event.pointerId);
            this.activePointers.delete(event.pointerId);
            if (this.activePointers.size < 2) {
                this.pinchSnapshot = null;
            }
            if (this.panState && event.pointerId === this.panState.pointerId) {
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                    event.currentTarget.releasePointerCapture(event.pointerId);
                }
                this.panState = null;
            }
        }

        setupPointerInteractions(mapRoot) {
            mapRoot.addEventListener("pointerdown", this.boundPointerDown);
            mapRoot.addEventListener("pointermove", this.boundPointerMove, { passive: false });
            mapRoot.addEventListener("pointerup", this.boundPointerUp);
            mapRoot.addEventListener("pointercancel", this.boundPointerCancel);
        }

        setupZoom(mapRoot) {
            if (!this.zoomControls) {
                return;
            }

            const zoomIn = this.zoomControls.querySelector(".country-map-zoom-btn--in");
            const zoomOut = this.zoomControls.querySelector(".country-map-zoom-btn--out");

            zoomIn?.addEventListener("click", (event) => {
                event.preventDefault();
                event.stopPropagation();
                const center = this.getMapCenterClientPoint(mapRoot);
                this.zoomByFactor(ZOOM_STEP, center.x, center.y);
            });

            zoomOut?.addEventListener("click", (event) => {
                event.preventDefault();
                event.stopPropagation();
                const center = this.getMapCenterClientPoint(mapRoot);
                this.zoomByFactor(1 / ZOOM_STEP, center.x, center.y);
            });

            mapRoot.addEventListener(
                "wheel",
                (event) => {
                    event.preventDefault();
                    const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
                    this.zoomByFactor(factor, event.clientX, event.clientY);
                },
                { passive: false },
            );
        }

        svgPointToScreen(svgX, svgY, coordSpace = "viewport") {
            if (!this.svg) {
                return null;
            }
            const point = this.svg.createSVGPoint();
            point.x = svgX;
            point.y = svgY;
            let matrix;
            if (coordSpace === "viewport") {
                matrix = this.viewport?.getScreenCTM();
            } else if (coordSpace === "inset") {
                matrix = this.insetScreenGroup?.getScreenCTM();
            } else if (coordSpace === "inset-drawer") {
                matrix = this.insetDrawerGroup?.getScreenCTM();
            } else {
                matrix = this.svg.getScreenCTM();
            }
            if (!matrix) {
                return null;
            }
            const screenPoint = point.matrixTransform(matrix);
            return [screenPoint.x, screenPoint.y];
        }

        syncOverlayPosition() {
            if (!this.overlay?.classList.contains("country-map-overlay--visible")) {
                return;
            }
            if (this.state.hoveredCountry && this.lastPointer) {
                this.placeOverlayFromClient(this.lastPointer.x, this.lastPointer.y);
            } else if (this.state.hoveredDestination) {
                this.positionOverlayAtFocus(this.state.hoveredDestination, true);
            } else if (this.state.hoveredRegion) {
                this.positionOverlayAtFocus(this.state.hoveredRegion);
            }
        }

        createMarker(meta, x, y, coordSpaceOverride) {
            const group = document.createElementNS(SVG_NS, "g");
            group.setAttribute("class", "country-map-marker");
            group.classList.toggle("country-map-marker--active", meta.active);
            group.classList.toggle("country-map-marker--inactive", !meta.active);
            group.dataset.destination = meta.name;
            group.dataset.region = meta.region || "";
            const isInset = this.isInsetPlane(meta.plane);
            group.dataset.coordSpace = coordSpaceOverride || (isInset ? "inset" : "root");
            group.dataset.localX = String(x);
            group.dataset.localY = String(y);
            group.setAttribute("role", "link");
            group.setAttribute("tabindex", "0");
            group.setAttribute(
                "aria-label",
                `${meta.name}, ${meta.locations} guide locations${meta.active ? "" : " (hidden)"}`,
            );

            const radius = this.getMarkerRadius(meta, false, group);
            const hitRadius = this.getMarkerHitRadius(meta, false, group);

            const hit = document.createElementNS(SVG_NS, "circle");
            hit.setAttribute("class", "country-map-marker__hit");
            hit.setAttribute("cx", String(x));
            hit.setAttribute("cy", String(y));
            hit.setAttribute("r", String(hitRadius));

            const dot = document.createElementNS(SVG_NS, "circle");
            dot.setAttribute("class", "country-map-marker__dot");
            dot.setAttribute("cx", String(x));
            dot.setAttribute("cy", String(y));
            dot.setAttribute("r", String(radius));
            this.applyMarkerGlowFilter(dot, meta.active);

            group.appendChild(hit);
            group.appendChild(dot);

            const activateMarker = (domEvent) => {
                domEvent.preventDefault();
                domEvent.stopPropagation();
                this.navigateToMarkerMeta(meta);
            };

            group.addEventListener("click", (domEvent) => {
                if (domEvent.pointerType === "touch") {
                    return;
                }
                if (Date.now() < this.suppressClickUntil) {
                    return;
                }
                activateMarker(domEvent);
            });
            group.addEventListener("keydown", (event) => {
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    if (meta.url) {
                        window.location.href = meta.url;
                    }
                }
            });

            this.markerElements.set(meta.name, group);
            return group;
        }

        handleRegionOver(event) {
            const regionPath = event.target.closest(".country-map-region[data-region]");
            if (!regionPath || this.state.hoveredDestination) {
                return;
            }
            const regionName = regionPath.dataset.region;
            if (this.state.hoveredRegion === regionName) {
                return;
            }
            this.state.hoveredRegion = regionName;
            this.state.hoveredCountry = null;
            this.applyShellState();
            this.showRegionOverlay(regionName);
        }

        handleRegionOut(event) {
            const regionPath = event.target.closest(".country-map-region[data-region]");
            if (!regionPath || this.state.hoveredDestination) {
                return;
            }
            const regionName = regionPath.dataset.region;
            const related = event.relatedTarget;
            if (related && typeof related.closest === "function") {
                const relatedRegion = related.closest(".country-map-region[data-region]");
                if (relatedRegion && relatedRegion.dataset.region === regionName) {
                    return;
                }
            }
            if (this.state.hoveredRegion === regionName) {
                this.state.hoveredRegion = null;
                this.applyShellState();
                this.hideOverlay();
            }
        }

        handleMarkerOver(event) {
            const marker = event.target.closest(".country-map-marker[data-destination]");
            if (!marker) {
                return;
            }
            const name = marker.dataset.destination;
            if (this.state.hoveredDestination === name) {
                return;
            }
            this.state.hoveredDestination = name;
            this.state.hoveredRegion = marker.dataset.region || null;
            this.state.hoveredCountry = null;
            marker.classList.add("country-map-marker--focused");
            const meta = this.getMarkerMeta(name);
            if (meta) {
                this.setMarkerRadius(marker, meta, true);
            }
            this.applyShellState();
            if (meta) {
                this.showDestinationOverlay(meta);
            }
        }

        handleMarkerOut(event) {
            const marker = event.target.closest(".country-map-marker[data-destination]");
            if (!marker) {
                return;
            }
            const related = event.relatedTarget;
            if (related && marker.contains(related)) {
                return;
            }
            const name = marker.dataset.destination;
            if (this.state.hoveredDestination !== name) {
                return;
            }
            this.state.hoveredDestination = null;
            this.state.hoveredRegion = null;
            marker.classList.remove("country-map-marker--focused");
            const meta = this.getMarkerMeta(name);
            if (meta) {
                this.setMarkerRadius(marker, meta, false);
            }
            this.applyShellState();
            this.hideOverlay();
        }

        handleNeighborOver(event) {
            const neighborPath = event.target.closest(".country-map-neighbor[data-country-code]");
            if (!neighborPath || this.state.hoveredDestination) {
                return;
            }
            const code = neighborPath.dataset.countryCode;
            if (this.state.hoveredCountry === code) {
                this.scheduleOverlayPosition(event.clientX, event.clientY);
                return;
            }
            this.state.hoveredCountry = code;
            this.state.hoveredRegion = null;
            this.applyShellState();
            const country = this.neighborByCode.get(code);
            if (country) {
                this.showCountryOverlay(country, event.clientX, event.clientY);
            }
        }

        handleNeighborOut(event) {
            const neighborPath = event.target.closest(".country-map-neighbor[data-country-code]");
            if (!neighborPath) {
                return;
            }
            const code = neighborPath.dataset.countryCode;
            const related = event.relatedTarget;
            if (related && typeof related.closest === "function") {
                const relatedNeighbor = related.closest(".country-map-neighbor[data-country-code]");
                if (relatedNeighbor && relatedNeighbor.dataset.countryCode === code) {
                    return;
                }
            }
            if (this.state.hoveredCountry === code) {
                this.state.hoveredCountry = null;
                this.applyShellState();
                this.hideOverlay();
            }
        }

        applyRegionActiveState() {
            if (!this.shell) {
                return;
            }
            this.shell.querySelectorAll(".country-map-region[data-region]").forEach((path) => {
                const regionName = path.dataset.region;
                path.classList.toggle(
                    "country-map-region--active",
                    this.regionHasActiveGuides(regionName),
                );
            });
        }

        applyShellState() {
            if (!this.shell) {
                return;
            }
            const { hoveredRegion, hoveredDestination, hoveredCountry } = this.state;
            const activeRegion = hoveredDestination
                ? this.findRegionForDestination(hoveredDestination)
                : hoveredRegion;

            if (activeRegion) {
                this.shell.setAttribute("data-hover-region", activeRegion);
            } else {
                this.shell.removeAttribute("data-hover-region");
            }
            if (hoveredDestination) {
                this.shell.setAttribute("data-hover-destination", hoveredDestination);
            } else {
                this.shell.removeAttribute("data-hover-destination");
            }
            if (hoveredCountry) {
                this.shell.setAttribute("data-hover-country", hoveredCountry);
            } else {
                this.shell.removeAttribute("data-hover-country");
            }

            this.shell.querySelectorAll(".country-map-neighbor[data-country-code]").forEach((path) => {
                const isTarget = path.dataset.countryCode === hoveredCountry;
                path.classList.toggle(
                    "country-map-neighbor--highlighted",
                    Boolean(hoveredCountry && isTarget),
                );
            });

            this.shell.querySelectorAll(".country-map-region[data-region]").forEach((path) => {
                const isTarget = path.dataset.region === activeRegion;
                path.classList.toggle(
                    "country-map-region--highlighted",
                    Boolean(activeRegion && isTarget),
                );
            });

            this.markerElements.forEach((marker, name) => {
                const region = marker.dataset.region;
                const isFocused = hoveredDestination === name;
                const inActiveRegion = Boolean(activeRegion && region === activeRegion);
                const meta = this.getMarkerMeta(name);
                const isActiveMarker = meta ? meta.active : true;
                marker.classList.toggle(
                    "country-map-marker--region-highlight",
                    Boolean(inActiveRegion && !hoveredDestination && isActiveMarker),
                );
                marker.classList.toggle(
                    "country-map-marker--in-region",
                    Boolean(inActiveRegion && !hoveredDestination && !isActiveMarker),
                );
            });
        }

        showCountryOverlay(country, clientX, clientY) {
            if (!this.overlay) {
                return;
            }
            this.overlay.innerHTML = this.buildCountryTooltipHtml(country);
            this.overlay.classList.add("country-map-overlay--visible");
            this.overlay.setAttribute("aria-hidden", "false");
            window.requestAnimationFrame(() => {
                this.placeOverlayFromClient(clientX, clientY);
            });
        }

        showRegionOverlay(regionName) {
            if (!this.overlay) {
                return;
            }
            const destinations = this.getDestinationsForRegion(regionName);
            const activation = this.activation;
            const total = activation
                ? countListedGuides(activation, destinations)
                : destinations.length;
            const active = activation
                ? countActiveGuides(activation, destinations)
                : destinations.length;

            this.overlay.innerHTML = this.buildRegionTooltipHtml(regionName, total, active);
            this.overlay.classList.add("country-map-overlay--visible");
            this.overlay.setAttribute("aria-hidden", "false");
            window.requestAnimationFrame(() => {
                this.positionOverlayAtFocus(regionName);
            });
        }

        showDestinationOverlay(meta) {
            if (!this.overlay) {
                return;
            }
            this.overlay.innerHTML = this.buildDestinationTooltipHtml(meta);
            this.overlay.classList.add("country-map-overlay--visible");
            this.overlay.setAttribute("aria-hidden", "false");
            window.requestAnimationFrame(() => {
                this.positionOverlayAtFocus(meta.name, true);
            });
        }

        isPointInMainViewport(svgX) {
            const frame = this.mapData?.main?.frame;
            if (!frame) {
                return true;
            }
            return svgX <= frame.x + frame.width;
        }

        getRegionAnchorPoint(regionName) {
            const destinations = this.getDestinationsForRegion(regionName)
                .map((name) => this.mapData.destinations[name])
                .filter(Boolean);
            if (!destinations.length) {
                return null;
            }
            const lat = destinations.reduce((sum, dest) => sum + dest.lat, 0) / destinations.length;
            const lng = destinations.reduce((sum, dest) => sum + dest.lng, 0) / destinations.length;
            const plane = this.resolveDestinationPlane(destinations[0]);
            return projectPoint(lat, lng, plane.bounds, plane.frame, plane.pad);
        }

        placeOverlayFromClient(clientX, clientY) {
            const mapRoot = this.root?.querySelector(".country-map-root");
            if (!this.overlay || !mapRoot) {
                return;
            }
            const rect = mapRoot.getBoundingClientRect();
            this.placeOverlay(clientX - rect.left, clientY - rect.top, mapRoot);
        }

        placeOverlay(anchorX, anchorY, mapRoot) {
            const rect = mapRoot.getBoundingClientRect();
            const margin = 12;
            const gap = 14;
            const overlayWidth = this.overlay.offsetWidth || 240;
            const overlayHeight = this.overlay.offsetHeight || 96;

            const x = Math.min(
                Math.max(anchorX, margin + overlayWidth / 2),
                rect.width - margin - overlayWidth / 2,
            );

            const spaceAbove = anchorY - margin;
            const spaceBelow = rect.height - anchorY - margin;
            const placeBelow =
                spaceAbove < overlayHeight + gap && spaceBelow >= spaceAbove;

            if (placeBelow) {
                this.overlay.style.transform = `translate(-50%, ${gap}px)`;
                const y = Math.min(anchorY, rect.height - margin - overlayHeight - gap);
                this.overlay.style.top = `${Math.max(margin, y)}px`;
            } else {
                this.overlay.style.transform = `translate(-50%, calc(-100% - ${gap}px))`;
                const y = Math.max(anchorY, margin + overlayHeight + gap);
                this.overlay.style.top = `${Math.min(y, rect.height - margin)}px`;
            }

            this.overlay.style.left = `${x}px`;
        }

        positionOverlayAtFocus(target, isDestination = false) {
            const mapRoot = this.root?.querySelector(".country-map-root");
            if (!this.overlay || !mapRoot) {
                return;
            }

            let point = null;
            if (isDestination) {
                const marker = this.markerElements.get(target);
                const dot = marker?.querySelector(".country-map-marker__dot");
                const coordSpace = marker?.dataset.coordSpace || "root";
                if (dot) {
                    point = [Number(dot.getAttribute("cx")), Number(dot.getAttribute("cy"))];
                    const rect = mapRoot.getBoundingClientRect();
                    const screenPoint = this.svgPointToScreen(point[0], point[1], coordSpace);
                    if (screenPoint) {
                        this.placeOverlay(
                            screenPoint[0] - rect.left,
                            screenPoint[1] - rect.top,
                            mapRoot,
                        );
                    }
                    return;
                }
            } else {
                point = this.getRegionAnchorPoint(target);
            }

            const rect = mapRoot.getBoundingClientRect();
            if (point) {
                const coordSpace = this.isPointInMainViewport(point[0])
                    ? "viewport"
                    : this.resolveInsetCoordSpace();
                const screenPoint = this.svgPointToScreen(point[0], point[1], coordSpace);
                if (screenPoint) {
                    this.placeOverlay(
                        screenPoint[0] - rect.left,
                        screenPoint[1] - rect.top,
                        mapRoot,
                    );
                    return;
                }
                const [, , vbW, vbH] = this.mapData.viewBox.split(/\s+/).map(Number);
                this.placeOverlay(
                    point[0] * (rect.width / vbW),
                    point[1] * (rect.height / vbH),
                    mapRoot,
                );
            } else if (this.lastPointer) {
                this.positionOverlay(this.lastPointer.x, this.lastPointer.y);
            }
        }

        scheduleOverlayPosition(clientX, clientY) {
            if (!this.overlay?.classList.contains("country-map-overlay--visible")) {
                return;
            }
            if (this.state.hoveredCountry) {
                if (this.overlayFrame) {
                    return;
                }
                this.overlayFrame = window.requestAnimationFrame(() => {
                    this.overlayFrame = null;
                    this.placeOverlayFromClient(clientX, clientY);
                });
                return;
            }
            if (this.overlayFrame) {
                return;
            }
            this.overlayFrame = window.requestAnimationFrame(() => {
                this.overlayFrame = null;
                this.positionOverlay(clientX, clientY);
            });
        }

        hideOverlay() {
            if (!this.overlay) {
                return;
            }
            this.overlay.classList.remove("country-map-overlay--visible");
            this.overlay.setAttribute("aria-hidden", "true");
        }

        positionOverlay(clientX, clientY) {
            const mapRoot = this.root?.querySelector(".country-map-root");
            if (!this.overlay || !mapRoot) {
                return;
            }
            const rect = mapRoot.getBoundingClientRect();
            this.placeOverlay(clientX - rect.left, clientY - rect.top, mapRoot);
        }

        handleKeyDown(event) {
            if (event.key !== "Escape") {
                return;
            }
            if (this.insetDrawerOpen) {
                this.setInsetDrawerOpen(false);
                return;
            }
            this.state.hoveredDestination = null;
            this.state.hoveredRegion = null;
            this.state.hoveredCountry = null;
            this.markerElements.forEach((marker) => {
                marker.classList.remove("country-map-marker--focused");
                const meta = this.getMarkerMeta(marker.dataset.destination);
                if (meta) {
                    this.setMarkerRadius(marker, meta, false);
                }
            });
            this.applyShellState();
            this.hideOverlay();
        }

        refresh() {
            this.applyRegionActiveState();
            this.shell?.querySelectorAll(".country-map-marker[data-destination]").forEach((marker) => {
                const meta = this.getMarkerMeta(marker.dataset.destination);
                if (meta) {
                    marker.classList.toggle("country-map-marker--active", meta.active);
                    marker.classList.toggle("country-map-marker--inactive", !meta.active);
                    this.applyMarkerGlowFilter(marker.querySelector(".country-map-marker__dot"), meta.active);
                }
            });
            this.applyShellState();
            this.updateLegendCounts();
            if (this.state.hoveredRegion && !this.state.hoveredDestination) {
                this.showRegionOverlay(this.state.hoveredRegion);
            } else if (this.state.hoveredDestination) {
                const meta = this.getMarkerMeta(this.state.hoveredDestination);
                if (meta) {
                    this.showDestinationOverlay(meta);
                }
            }
        }

        destroy() {
            document.removeEventListener("keydown", this.boundKeyDown);
            if (this.insetMobileQuery && this.boundInsetMobileChange) {
                if (typeof this.insetMobileQuery.removeEventListener === "function") {
                    this.insetMobileQuery.removeEventListener("change", this.boundInsetMobileChange);
                } else if (typeof this.insetMobileQuery.removeListener === "function") {
                    this.insetMobileQuery.removeListener(this.boundInsetMobileChange);
                }
            }
            if (this.markerTouchQuery && this.boundMarkerTouchChange) {
                if (typeof this.markerTouchQuery.removeEventListener === "function") {
                    this.markerTouchQuery.removeEventListener("change", this.boundMarkerTouchChange);
                } else if (typeof this.markerTouchQuery.removeListener === "function") {
                    this.markerTouchQuery.removeListener(this.boundMarkerTouchChange);
                }
            }
            if (this.insetResizeObserver) {
                this.insetResizeObserver.disconnect();
                this.insetResizeObserver = null;
            }
            if (mapInstance === this) {
                mapInstance = null;
            }
        }
    }

    window.TGCountryMap = {
        async init(options) {
            const instance = new CountryMap(options);
            const ready = await instance.init();
            return ready ? instance : null;
        },

        refresh() {
            mapInstance?.refresh();
        },

        getInstance() {
            return mapInstance;
        },
    };
})();
