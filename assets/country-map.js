(function () {
    const SVG_NS = "http://www.w3.org/2000/svg";
    const TOUCH_PAN_THRESHOLD = 10;
    const GESTURE_SUPPRESS_MS = 350;
    const MARKER_LOC_MAX = 40;
    const ZOOM_MAX = 8;
    const ZOOM_STEP = 1.35;
    const MOBILE_INSET_MAX_WIDTH = 767;
    const MODERN_MARKER_RADIUS_MIN_PX = 6;
    const MODERN_MARKER_RADIUS_MAX_PX = 14;
    const MODERN_MARKER_HIT_RADIUS_PX = 24;
    const MODERN_MARKER_SCALE_MIN = 0.85;
    const MODERN_MARKER_SCALE_MAX = 1.15;

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
                selectedDestination: null,
            };
            this.neighborByCode = new Map();
            this.destinationRegionByName = new Map();
            Object.entries(options.countryData || {}).forEach(([region, destinations]) => {
                destinations.forEach((name) => this.destinationRegionByName.set(name, region));
            });
            this.markerElements = new Map();
            this.regionElements = [];
            this.neighborElements = [];
            this.overlay = null;
            this.overlayFrame = null;
            this.pendingOverlayPoint = null;
            this.transformFrame = null;
            this.layoutFrame = null;
            this.baseCanvas = null;
            this.baseCanvasContext = null;
            this.baseCanvasFrame = null;
            this.baseCanvasPaths = [];
            this.baseCanvasStyle = null;
            this.lastPointer = null;
            this.svg = null;
            this.viewport = null;
            this.insetMarkersLayer = null;
            this.insetScreenGroup = null;
            this.insetDrawer = null;
            this.insetDrawerGroup = null;
            this.insetDrawerMarkersLayer = null;
            this.insetToggle = null;
            this.insetDrawerOpen = false;
            this.lastMobileLayout = null;
            this.insetMobileQuery = null;
            this.boundInsetMobileChange = null;
            this.markerTouchQuery = null;
            this.boundMarkerTouchChange = null;
            this.panelResizeObserver = null;
            this.renderObserver = null;
            this.baseAlign = "xMaxYMid meet";
            this.zoomState = { scale: 1, x: 0, y: 0 };
            this.defaultZoomState = { scale: 1, x: 0, y: 0 };
            this.zoomControls = null;
            this.selectionPanel = null;
            this.panState = null;
            this.activePointers = new Map();
            this.pinchSnapshot = null;
            this.pointerStarts = new Map();
            this.suppressClickUntil = 0;
            this.boundPointerDown = this.handlePointerDown.bind(this);
            this.boundPointerMove = this.handlePointerMove.bind(this);
            this.boundPointerUp = this.handlePointerUp.bind(this);
            this.boundPointerCancel = this.handlePointerCancel.bind(this);
            this.boundTouchMove = this.handleTouchMove.bind(this);
            this.boundNativeGesture = this.handleNativeGesture.bind(this);
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
                this.mapData = await resolveMapData(this.options);
                if (!this.mapData?.main?.frame || !this.mapData?.main?.regions) {
                    throw new Error("unsupported country map payload");
                }
                this.defaultZoomState = this.resolveDefaultZoomState();
                this.zoomState = { ...this.defaultZoomState };
            } catch (error) {
                this.renderFallback();
                console.warn("Country map unavailable:", error);
                return false;
            }

            mapInstance = this;
            if (
                this.options.lazyRender !== false &&
                typeof IntersectionObserver !== "undefined"
            ) {
                this.root.classList.add("country-map--pending");
                this.root.setAttribute("aria-busy", "true");
                this.renderObserver = new IntersectionObserver((entries) => {
                    if (!entries.some((entry) => entry.isIntersecting)) {
                        return;
                    }
                    this.renderObserver?.disconnect();
                    this.renderObserver = null;
                    this.root.classList.remove("country-map--pending");
                    this.root.setAttribute("aria-busy", "false");
                    this.render();
                }, { rootMargin: "500px 0px" });
                this.renderObserver.observe(this.root);
                return true;
            }
            this.render();
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
            return this.destinationRegionByName.get(name) || null;
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

        getMarkerRadius(meta, focused = false, marker = null, screenScale = null) {
            const count = Math.max(0, Math.min(MARKER_LOC_MAX, Number(meta.locations) || 0));
            const progress = Math.sqrt(count / MARKER_LOC_MAX);
            const cssRadius = MODERN_MARKER_RADIUS_MIN_PX +
                (MODERN_MARKER_RADIUS_MAX_PX - MODERN_MARKER_RADIUS_MIN_PX) * progress +
                (focused ? 2 : 0);
            const configuredScale = Number(this.mapData?.markerRadiusScale) || 1;
            const markerRadiusScale = Math.min(
                MODERN_MARKER_SCALE_MAX,
                Math.max(MODERN_MARKER_SCALE_MIN, configuredScale),
            );
            return (cssRadius * markerRadiusScale) /
                (screenScale || this.getMarkerScreenScale(marker));
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

        getMarkerHitRadius(meta, focused = false, marker = null, visualRadius = null, screenScale = null) {
            const resolvedScale = screenScale || this.getMarkerScreenScale(marker);
            const resolvedRadius = visualRadius ??
                this.getMarkerRadius(meta, focused, marker, resolvedScale);
            return this.useExpandedMarkerHit()
                ? Math.max(resolvedRadius, MODERN_MARKER_HIT_RADIUS_PX / resolvedScale)
                : resolvedRadius;
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
                marker.querySelectorAll(".country-map-marker__halo, .country-map-marker__dot, .country-map-marker__hit").forEach((node) => {
                    node.setAttribute("cx", String(screenX));
                    node.setAttribute("cy", String(screenY));
                });
            });
        }

        isInsetPlane(plane) {
            return Boolean(plane && plane !== "main" && String(plane).startsWith("inset:"));
        }

        setMarkerRadius(marker, meta, focused = false, screenScale = null) {
            const dot = marker?.querySelector(".country-map-marker__dot");
            const halo = marker?.querySelector(".country-map-marker__halo");
            const hit = marker?.querySelector(".country-map-marker__hit");
            const resolvedScale = screenScale || this.getMarkerScreenScale(marker);
            const visualRadius = this.getMarkerRadius(meta, focused, marker, resolvedScale);
            const hitRadius = this.getMarkerHitRadius(
                meta,
                focused,
                marker,
                visualRadius,
                resolvedScale,
            );
            if (dot) {
                dot.setAttribute("r", String(visualRadius));
            }
            if (halo) {
                halo.setAttribute("r", String(visualRadius * 1.65));
            }
            if (hit) {
                hit.setAttribute("r", String(hitRadius));
            }
        }

        syncAllMarkerGeometry() {
            const screenScales = new Map();
            this.markerElements.forEach((marker, name) => {
                const meta = this.getMarkerMeta(name);
                if (!meta) {
                    return;
                }
                const focused = marker.classList.contains("country-map-marker--focused");
                const coordSpace = marker.dataset.coordSpace || "root";
                if (!screenScales.has(coordSpace)) {
                    screenScales.set(coordSpace, this.getMarkerScreenScale(marker));
                }
                this.setMarkerRadius(marker, meta, focused, screenScales.get(coordSpace));
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

        parseViewBox(viewBox) {
            const [x, y, w, h] = String(viewBox || "0 0 0 0").split(/\s+/).map(Number);
            return { x, y, w, h };
        }

        formatViewBox({ x, y, w, h }) {
            return `${x} ${y} ${w} ${h}`;
        }

        applyViewBox(viewBoxParts) {
            if (!this.svg) {
                return;
            }
            const viewBox = this.formatViewBox(viewBoxParts);
            this.svg.setAttribute("viewBox", viewBox);
            const canvas = this.svg.querySelector(".country-map-canvas");
            if (canvas) {
                canvas.setAttribute("x", String(viewBoxParts.x));
                canvas.setAttribute("y", String(viewBoxParts.y));
                canvas.setAttribute("width", String(viewBoxParts.w));
                canvas.setAttribute("height", String(viewBoxParts.h));
            }
        }

        formatPreserveAspectRatio(align) {
            const value = String(align || "xMaxYMid meet");
            return /\s(meet|slice)$/i.test(value) ? value : `${value} meet`;
        }

        fitViewBoxToPanel() {
            const mapRoot = this.root?.querySelector(".country-map-root");
            if (!mapRoot || !this.svg) {
                return;
            }
            const rect = mapRoot.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) {
                return;
            }

            const base = this.getResponsiveBaseViewBox();
            const responsiveAlign = this.isMobileInsetLayout()
                ? "xMidYMid meet"
                : this.baseAlign;
            const baseAlign = this.formatPreserveAspectRatio(responsiveAlign);
            const [, parMode = "meet"] = baseAlign.match(/\s(meet|slice)$/i) || [];
            const baseAnchor = baseAlign.split(/\s+/)[0] || "xMaxYMid";
            const neededW = rect.width * (base.h / rect.height);
            const mainFrame = this.mapData?.main?.frame;
            const regionsLayer = this.svg.querySelector(".country-map-regions");
            let geometryBounds = null;
            try {
                geometryBounds = regionsLayer?.getBBox?.() || null;
            } catch (_error) {
                geometryBounds = null;
            }
            const hasGeometryBounds = geometryBounds && geometryBounds.width > 0;
            const geometryCenterX = hasGeometryBounds
                ? geometryBounds.x + geometryBounds.width / 2
                : mainFrame
                    ? Number(mainFrame.x) + Number(mainFrame.width) / 2
                    : base.x + base.w / 2;
            const targetCenterX = geometryCenterX * this.zoomState.scale + this.zoomState.x;
            const wideDesktopNudgePx = (
                !this.isMobileInsetLayout() && window.innerWidth >= 1800
            ) ? Number(this.mapData?.wideDesktopNudgePx) || 0 : 0;
            const wideDesktopNudgeX = wideDesktopNudgePx * (neededW / rect.width);

            if (!this.isMobileInsetLayout() && neededW < base.w - 0.5) {
                const centeredCropX = targetCenterX - neededW / 2 - wideDesktopNudgeX;
                this.svg.setAttribute("preserveAspectRatio", baseAlign);
                this.applyViewBox({ x: centeredCropX, y: base.y, w: neededW, h: base.h });
                return;
            }

            if (neededW <= base.w + 0.5) {
                this.svg.setAttribute("preserveAspectRatio", baseAlign);
                this.applyViewBox(base);
                return;
            }

            // Japan: extend viewBox east + xMinYMid (insets fill the right column).
            // Other countries: center their transformed target geometry. This is
            // especially important on 1920px+ panels, where edge-anchoring left
            // France, Italy, Portugal, and Spain with uneven empty space.
            const useJapanWideFit = this.options.mapId === "japan";
            const fitted = useJapanWideFit
                ? { x: base.x, y: base.y, w: neededW, h: base.h }
                : {
                    x: targetCenterX - neededW / 2 - wideDesktopNudgeX,
                    y: base.y,
                    w: neededW,
                    h: base.h,
                };
            const panelAlign = useJapanWideFit
                ? (baseAnchor.startsWith("xMax") ? `xMinYMid ${parMode}` : baseAlign)
                : baseAlign;
            this.svg.setAttribute("preserveAspectRatio", panelAlign);
            this.applyViewBox(fitted);
        }

        setupPanelResizeObserver() {
            if (this.panelResizeObserver) {
                this.panelResizeObserver.disconnect();
                this.panelResizeObserver = null;
            }
            if (this.renderObserver) {
                this.renderObserver.disconnect();
                this.renderObserver = null;
            }
            const target = this.root;
            if (!target || typeof ResizeObserver === "undefined") {
                return;
            }
            this.panelResizeObserver = new ResizeObserver(() => {
                this.schedulePanelLayout();
            });
            this.panelResizeObserver.observe(target);
        }

        schedulePanelLayout() {
            if (this.layoutFrame) {
                return;
            }
            this.layoutFrame = window.requestAnimationFrame(() => {
                this.layoutFrame = null;
                this.syncInsetMobileState(true);
                this.fitViewBoxToPanel();
                this.syncAllMarkerGeometry();
                if (!this.isMobileInsetLayout()) {
                    this.syncInsetScreenTransform();
                }
                this.scheduleBaseCanvasRender();
            });
        }

        resolveDefaultZoomState() {
            if (this.isMobileInsetLayout()) {
                const mobileView = this.mapData?.main?.mobileDefaultView;
                return mobileView
                    ? {
                        scale: Number(mobileView.scale) || 1,
                        x: Number(mobileView.x) || 0,
                        y: Number(mobileView.y) || 0,
                    }
                    : { scale: 1, x: 0, y: 0 };
            }
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

        getOuterSvgScreenScale() {
            const matrix = this.svg?.getScreenCTM?.();
            if (matrix?.a) {
                return Math.abs(matrix.a);
            }
            const rect = this.root?.getBoundingClientRect?.();
            const viewBox = this.svg?.viewBox?.baseVal;
            if (rect?.width && viewBox?.width) {
                return rect.width / viewBox.width;
            }
            return 1;
        }

        getMarkerScreenScale(marker) {
            if (marker?.dataset.coordSpace === "inset-drawer") {
                const matrix = marker.ownerSVGElement?.getScreenCTM?.();
                if (matrix?.a) {
                    return Math.abs(matrix.a);
                }
            }
            return this.getOuterSvgScreenScale();
        }

        getResponsiveBaseViewBox() {
            if (!this.isMobileInsetLayout()) {
                return this.parseViewBox(this.mapData.viewBox);
            }
            const frame = this.mapData.main.frame;
            const padX = 16;
            const padY = 12;
            return {
                x: frame.x - padX,
                y: frame.y - padY,
                w: frame.width + padX * 2,
                h: frame.height + padY * 2,
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
            const bakedUrl = country.url || null;
            const url = guide?.url || bakedUrl || null;
            const hasGuide = Boolean(url);
            const activation = window.TGActivation;
            const active = activation
                ? activation.isCodeVisuallyActive(country.code)
                : Boolean(
                      window.TGCountryActiveCodes?.has(normalizeCountryCode(country.code)),
                  );
            return {
                url,
                hasGuide,
                active,
                continent:
                    guide?.continent ||
                    country.continent ||
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
            path.dataset.hasGuide = hasGuide ? "true" : "false";
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
            path.setAttribute("role", "group");
            path.setAttribute("aria-label", `${regionName} region`);
            path.addEventListener("mousedown", (event) => {
                event.preventDefault();
            });
            path.addEventListener("focus", () => {
                this.state.hoveredRegion = regionName;
                this.applyShellState();
                this.showRegionOverlay(regionName);
            });
            path.addEventListener("blur", () => {
                if (this.state.hoveredRegion === regionName) {
                    this.state.hoveredRegion = null;
                    this.applyShellState();
                    this.hideOverlay();
                }
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

            const header = document.createElement("div");
            header.className = "country-map-inset-drawer__header";
            const close = document.createElement("button");
            close.type = "button";
            close.className = "country-map-inset-drawer__close";
            close.setAttribute("aria-label", "Close additional regions");
            close.innerHTML = '<span aria-hidden="true">&times;</span>';
            close.addEventListener("click", () => this.setInsetDrawerOpen(false));
            header.appendChild(title);
            header.appendChild(close);

            const svg = document.createElementNS(SVG_NS, "svg");
            svg.setAttribute("class", "country-map-inset-drawer__svg");
            svg.setAttribute("viewBox", this.computeInsetViewBox());
            svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
            svg.setAttribute("role", "img");
            svg.setAttribute("aria-label", "Island and territory regions");

            const defs = document.createElementNS(SVG_NS, "defs");
            svg.appendChild(defs);

            const drawerGroup = document.createElementNS(SVG_NS, "g");
            drawerGroup.setAttribute("class", "country-map-inset-drawer__content");
            drawerGroup.appendChild(this.buildInsetsLayer());
            this.insetDrawerMarkersLayer = this.buildInsetMarkersLayer("inset-drawer");
            drawerGroup.appendChild(this.insetDrawerMarkersLayer);
            svg.appendChild(drawerGroup);

            panel.appendChild(header);
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

        syncInsetMobileState(deferLayoutWork = false) {
            if (!this.hasMapInsets()) {
                return;
            }

            const mobile = this.isMobileInsetLayout();
            if (this.lastMobileLayout !== null && mobile !== this.lastMobileLayout) {
                this.defaultZoomState = this.resolveDefaultZoomState();
                this.zoomState = { ...this.defaultZoomState };
                this.applyZoomTransform();
            }
            this.lastMobileLayout = mobile;
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
            if (deferLayoutWork) {
                return;
            }
            this.syncAllMarkerGeometry();
            if (!mobile) {
                this.syncInsetScreenTransform();
            }
        }

        setupInsetMobileListener() {
            if (!this.hasMapInsets() || typeof window === "undefined" || !window.matchMedia) {
                return;
            }
            this.insetMobileQuery = window.matchMedia(`(max-width: ${MOBILE_INSET_MAX_WIDTH}px)`);
            this.boundInsetMobileChange = () => this.schedulePanelLayout();
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
            this.shell.className = "country-map-shell country-map-shell--modern";

            const mapRoot = document.createElement("div");
            mapRoot.className = "country-map-root country-map-root--modern";
            // Germany's previous desktop rendering is the visual reference.
            // Keep the same apparent weight regardless of a map's default zoom.
            mapRoot.style.setProperty("--country-map-region-stroke", "3.2053");
            mapRoot.style.setProperty("--country-map-neighbor-stroke", "2.2895");

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

            const vbParts = viewBox.split(/\s+/).map(Number);
            if (vbParts.length === 4) {
                const [vbX, vbY, vbW, vbH] = vbParts;
                const canvas = document.createElementNS(SVG_NS, "rect");
                canvas.setAttribute("x", String(vbX));
                canvas.setAttribute("y", String(vbY));
                canvas.setAttribute("width", String(vbW));
                canvas.setAttribute("height", String(vbH));
                canvas.setAttribute("class", "country-map-canvas");
                svg.appendChild(canvas);
            }

            const defs = document.createElementNS(SVG_NS, "defs");
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
            this.selectionPanel = this.createSelectionPanel();
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
            if (this.selectionPanel) {
                this.shell.appendChild(this.selectionPanel);
            }
            this.root.innerHTML = "";
            this.root.appendChild(this.shell);
            // Cache the final mounted collections once. This includes both the
            // desktop inset paths and their mobile-drawer counterparts.
            this.neighborElements = [...this.shell.querySelectorAll(".country-map-neighbor")];
            this.regionElements = [...this.shell.querySelectorAll(".country-map-region")];
            this.setupBaseCanvas(mapRoot, neighborsLayer, regionsLayer);

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
            this.baseAlign = this.mapData.align || "xMaxYMid meet";
            this.applyZoomTransform();
            this.fitViewBoxToPanel();
            this.syncInsetScreenTransform();
            this.setupPanelResizeObserver();
            this.setupInsetMobileListener();
            this.setupMarkerTouchListener();
            this.syncInsetMobileState();
            this.updateLegendCounts();
        }

        getInsetScreenOffset() {
            const insets = this.mapData.insets || [];
            if (!insets.length || !this.svg) {
                return { dx: 0, dy: 0 };
            }

            const viewBox = this.parseViewBox(this.svg.getAttribute("viewBox") || this.mapData.viewBox);
            const margin = 12;
            const bottomInset = insets.reduce((lowest, inset) =>
                inset.frame.y > lowest.frame.y ? inset : lowest,
            );
            const targetX = viewBox.x + viewBox.w - margin - bottomInset.frame.width;
            const targetY = viewBox.y + viewBox.h - margin - bottomInset.frame.height;
            return {
                dx: targetX - bottomInset.frame.x,
                dy: targetY - bottomInset.frame.y,
            };
        }

        syncInsetScreenTransform() {
            if (!this.svg || !this.insetScreenGroup || this.isMobileInsetLayout()) {
                return;
            }
            const insets = this.mapData.insets || [];
            if (!insets.length) {
                this.insetScreenGroup.removeAttribute("transform");
                return;
            }

            const { dx, dy } = this.getInsetScreenOffset();
            const rect = this.svg.getBoundingClientRect();
            const viewBox = this.svg.getAttribute("viewBox") || this.mapData.viewBox;
            const [, , vbW, vbH] = viewBox.split(/\s+/).map(Number);
            const parts = [];

            if (Math.abs(dx) > 0.001 || Math.abs(dy) > 0.001) {
                parts.push(`translate(${dx} ${dy})`);
            }

            if (rect.width > 0 && rect.height > 0 && vbW > 0 && vbH > 0) {
                const meetScale = Math.min(rect.width / vbW, rect.height / vbH);
                if (meetScale > 0) {
                    const counterScale = 1 / meetScale;
                    if (Math.abs(counterScale - 1) >= 0.001) {
                        const frames = insets.map((inset) => inset.frame);
                        const pivotX = frames[0].x + frames[0].width / 2;
                        const minY = Math.min(...frames.map((frame) => frame.y));
                        const maxY = Math.max(...frames.map((frame) => frame.y + frame.height));
                        const pivotY = (minY + maxY) / 2;
                        parts.push(
                            `translate(${pivotX} ${pivotY}) scale(${counterScale}) translate(${-pivotX} ${-pivotY})`,
                        );
                    }
                }
            }

            if (parts.length) {
                this.insetScreenGroup.setAttribute("transform", parts.join(" "));
            } else {
                this.insetScreenGroup.removeAttribute("transform");
            }
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
            controls.className = "country-map-zoom-controls country-map-zoom-controls--modern";
            controls.innerHTML = `
                <button type="button" class="country-map-zoom-btn country-map-zoom-btn--in" aria-label="Zoom in">+</button>
                <button type="button" class="country-map-zoom-btn country-map-zoom-btn--out" aria-label="Zoom out">&minus;</button>
                <button type="button" class="country-map-zoom-btn country-map-zoom-btn--reset" aria-label="Reset map view"><span aria-hidden="true">&#8634;</span></button>
            `;
            return controls;
        }

        createSelectionPanel() {
            const panel = document.createElement("aside");
            panel.className = "country-map-selection";
            panel.hidden = true;
            panel.setAttribute("aria-live", "polite");
            panel.setAttribute("aria-label", "Selected destination");
            panel.addEventListener("click", (event) => {
                if (event.target.closest(".country-map-selection__close")) {
                    this.clearSelectedDestination();
                }
            });
            return panel;
        }

        selectDestination(meta) {
            if (!meta || !this.selectionPanel) {
                return;
            }
            this.state.selectedDestination = meta.name;
            this.markerElements.forEach((marker, name) => {
                marker.classList.toggle("country-map-marker--selected", name === meta.name);
                this.setMarkerRadius(marker, this.getMarkerMeta(name), name === meta.name);
            });
            this.selectionPanel.innerHTML = `
                <button type="button" class="country-map-selection__close" aria-label="Close destination details">&times;</button>
                <div class="country-map-selection__eyebrow">${escapeHtml(meta.region || this.options.countryName)}</div>
                <div class="country-map-selection__body">
                    <div>
                        <strong class="country-map-selection__title">${escapeHtml(meta.name)}</strong>
                        <span class="country-map-selection__meta">${meta.locations} guide location${meta.locations === 1 ? "" : "s"}</span>
                    </div>
                    ${meta.url ? `<a class="country-map-selection__cta" href="${escapeHtml(meta.url)}">Open guide <span aria-hidden="true">&rarr;</span></a>` : ""}
                </div>
            `;
            this.selectionPanel.hidden = false;
            this.hideOverlay();
        }

        clearSelectedDestination() {
            this.state.selectedDestination = null;
            this.markerElements.forEach((marker, name) => {
                marker.classList.remove("country-map-marker--selected");
                const meta = this.getMarkerMeta(name);
                if (meta) {
                    this.setMarkerRadius(marker, meta, false);
                }
            });
            if (this.selectionPanel) {
                this.selectionPanel.hidden = true;
                this.selectionPanel.innerHTML = "";
            }
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
            const zoomIn = this.zoomControls?.querySelector(".country-map-zoom-btn--in");
            const zoomOut = this.zoomControls?.querySelector(".country-map-zoom-btn--out");
            const reset = this.zoomControls?.querySelector(".country-map-zoom-btn--reset");
            if (zoomIn) zoomIn.disabled = scale >= ZOOM_MAX - 0.001;
            if (zoomOut) zoomOut.disabled = !this.isZoomedIn();
            if (reset) reset.disabled = !this.isZoomedIn();
            this.scheduleBaseCanvasRender();
            this.syncOverlayPosition();
        }

        setupBaseCanvas(mapRoot, neighborsLayer, regionsLayer) {
            if (typeof window.Path2D === "undefined") {
                return;
            }
            const canvas = document.createElement("canvas");
            canvas.className = "country-map-base-canvas";
            canvas.setAttribute("aria-hidden", "true");
            const context = canvas.getContext("2d", { alpha: true });
            if (!context) {
                return;
            }
            this.baseCanvas = canvas;
            this.baseCanvasContext = context;
            this.baseCanvasPaths = [
                ...neighborsLayer.querySelectorAll(".country-map-neighbor"),
                ...regionsLayer.querySelectorAll(".country-map-region"),
            ].map((element) => ({
                element,
                path: new Path2D(element.getAttribute("d") || ""),
                type: element.classList.contains("country-map-neighbor") ? "neighbor" : "region",
            }));
            this.baseCanvasStyle = this.readBaseCanvasStyle(mapRoot);
            mapRoot.classList.add("country-map-root--canvas-base");
            mapRoot.insertBefore(canvas, this.svg);
        }

        scheduleBaseCanvasRender() {
            if (!this.baseCanvas || this.baseCanvasFrame) {
                return;
            }
            this.baseCanvasFrame = window.requestAnimationFrame(() => {
                this.baseCanvasFrame = null;
                this.renderBaseCanvas();
            });
        }

        getBaseCanvasStyle(entry, palette) {
            const element = entry.element;
            if (entry.type === "region") {
                if (element.classList.contains("country-map-region--highlighted")) {
                    return {
                        fill: element.classList.contains("country-map-region--active")
                            ? palette.regionActiveHighlight
                            : palette.regionHighlight,
                        stroke: palette.stroke,
                    };
                }
                return {
                    fill: element.classList.contains("country-map-region--active")
                        ? palette.regionActive
                        : palette.region,
                    stroke: palette.stroke,
                };
            }
            if (element.classList.contains("country-map-neighbor--highlighted-preview")) {
                return { fill: palette.neighborPreview, stroke: palette.stroke };
            }
            if (element.classList.contains("country-map-neighbor--highlighted-static")) {
                return { fill: palette.neighborStatic, stroke: palette.stroke };
            }
            if (element.classList.contains("country-map-neighbor--highlighted")) {
                return { fill: palette.neighborHighlight, stroke: palette.stroke };
            }
            return { fill: palette.neighbor, stroke: palette.stroke };
        }

        readBaseCanvasStyle(mapRoot) {
            const rootStyle = getComputedStyle(mapRoot);
            const themed = document.body.classList.contains("tg-theme");
            return {
                palette: themed
                    ? {
                        region: "#2a2f38",
                        regionActive: rootStyle.getPropertyValue("--tg-amber").trim() || "#e8b14f",
                        regionHighlight: "#3a4049",
                        regionActiveHighlight: rootStyle.getPropertyValue("--tg-amber-soft").trim() || "#fff4d6",
                        neighbor: "#23272e",
                        neighborPreview: rootStyle.getPropertyValue("--tg-teal").trim() || "#4fbdba",
                        neighborStatic: "#3a4049",
                        neighborHighlight: "#1e336b",
                        stroke: rootStyle.getPropertyValue("--tg-charcoal").trim() || "#121417",
                    }
                    : {
                        region: "#15234b",
                        regionActive: "#00f0ff",
                        regionHighlight: "#1e336b",
                        regionActiveHighlight: "#0070ff",
                        neighbor: "#15234b",
                        neighborPreview: "#4fbdba",
                        neighborStatic: "#3a4049",
                        neighborHighlight: "#1e336b",
                        stroke: "#060b19",
                    },
                regionStroke: Number(rootStyle.getPropertyValue("--country-map-region-stroke")) || 3.5,
                neighborStroke: Number(rootStyle.getPropertyValue("--country-map-neighbor-stroke")) || 2.5,
            };
        }

        renderBaseCanvas() {
            const canvas = this.baseCanvas;
            const context = this.baseCanvasContext;
            const mapRoot = this.root?.querySelector(".country-map-root");
            const viewBox = this.svg?.viewBox?.baseVal;
            if (!canvas || !context || !mapRoot || !viewBox?.width || !viewBox?.height) {
                return;
            }
            const rect = mapRoot.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) {
                return;
            }
            const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
            const width = Math.max(1, Math.round(rect.width * pixelRatio));
            const height = Math.max(1, Math.round(rect.height * pixelRatio));
            if (canvas.width !== width || canvas.height !== height) {
                canvas.width = width;
                canvas.height = height;
            }
            context.setTransform(1, 0, 0, 1, 0, 0);
            context.clearRect(0, 0, width, height);

            const screenScale = Math.min(rect.width / viewBox.width, rect.height / viewBox.height);
            const renderedWidth = viewBox.width * screenScale;
            const renderedHeight = viewBox.height * screenScale;
            const align = this.svg.getAttribute("preserveAspectRatio") || "xMaxYMid meet";
            const offsetX = align.startsWith("xMin")
                ? 0
                : align.startsWith("xMid")
                    ? (rect.width - renderedWidth) / 2
                    : rect.width - renderedWidth;
            const offsetY = align.includes("YMin")
                ? 0
                : align.includes("YMax")
                    ? rect.height - renderedHeight
                    : (rect.height - renderedHeight) / 2;
            const { scale, x, y } = this.zoomState;
            context.setTransform(
                pixelRatio * screenScale * scale,
                0,
                0,
                pixelRatio * screenScale * scale,
                pixelRatio * (offsetX + (x - viewBox.x) * screenScale),
                pixelRatio * (offsetY + (y - viewBox.y) * screenScale),
            );
            context.lineJoin = "round";
            context.lineCap = "round";
            const { palette, regionStroke, neighborStroke } =
                this.baseCanvasStyle || this.readBaseCanvasStyle(mapRoot);
            for (const entry of this.baseCanvasPaths) {
                const style = this.getBaseCanvasStyle(entry, palette);
                context.fillStyle = style.fill;
                context.strokeStyle = style.stroke;
                const fixedScreenWidth = entry.type === "region" ? regionStroke : neighborStroke;
                context.lineWidth = fixedScreenWidth / (screenScale * scale);
                context.fill(entry.path, "evenodd");
                context.stroke(entry.path);
            }
        }

        scheduleZoomTransform() {
            if (this.transformFrame) {
                return;
            }
            this.transformFrame = window.requestAnimationFrame(() => {
                this.transformFrame = null;
                this.applyZoomTransform();
            });
        }

        flushZoomTransform() {
            if (!this.transformFrame) {
                return;
            }
            window.cancelAnimationFrame(this.transformFrame);
            this.transformFrame = null;
            this.applyZoomTransform();
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
                // Claim the pinch before the browser can promote it to page zoom.
                // `touch-action` handles standards-compliant browsers; this
                // preventDefault is also needed by older mobile Safari versions.
                event.preventDefault();
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
            // Pointer streams can outpace the display refresh rate. Coalescing
            // pan updates prevents repeatedly tessellating complex coastlines
            // for frames the browser can never present.
            this.scheduleZoomTransform();
        }

        handlePointerUp(event) {
            this.flushZoomTransform();
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
                this.clearSelectedDestination();
                return;
            }
            const meta = this.getMarkerMeta(marker.dataset.destination);
            if (meta) {
                this.selectDestination(meta);
            }
        }

        handlePointerCancel(event) {
            this.flushZoomTransform();
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

        handleTouchMove(event) {
            if (event.touches.length > 1) {
                event.preventDefault();
            }
        }

        handleNativeGesture(event) {
            event.preventDefault();
        }

        setupPointerInteractions(mapRoot) {
            mapRoot.addEventListener("pointerdown", this.boundPointerDown);
            mapRoot.addEventListener("pointermove", this.boundPointerMove, { passive: false });
            mapRoot.addEventListener("pointerup", this.boundPointerUp);
            mapRoot.addEventListener("pointercancel", this.boundPointerCancel);
            // Keep one-finger vertical page scrolling, but reserve two-finger
            // movement for the country map. Safari's gesture events are a
            // fallback for versions that do not fully honor touch-action.
            mapRoot.addEventListener("touchmove", this.boundTouchMove, { passive: false });
            mapRoot.addEventListener("gesturestart", this.boundNativeGesture, { passive: false });
            mapRoot.addEventListener("gesturechange", this.boundNativeGesture, { passive: false });
            mapRoot.addEventListener("gestureend", this.boundNativeGesture, { passive: false });
        }

        setupZoom(mapRoot) {
            if (!this.zoomControls) {
                return;
            }

            const zoomIn = this.zoomControls.querySelector(".country-map-zoom-btn--in");
            const zoomOut = this.zoomControls.querySelector(".country-map-zoom-btn--out");
            const reset = this.zoomControls.querySelector(".country-map-zoom-btn--reset");

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

            reset?.addEventListener("click", (event) => {
                event.preventDefault();
                event.stopPropagation();
                this.zoomState = { ...this.defaultZoomState };
                this.applyZoomTransform();
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

            const screenScale = this.getMarkerScreenScale(group);
            const radius = this.getMarkerRadius(meta, false, group, screenScale);
            const hitRadius = this.getMarkerHitRadius(
                meta,
                false,
                group,
                radius,
                screenScale,
            );

            const hit = document.createElementNS(SVG_NS, "circle");
            hit.setAttribute("class", "country-map-marker__hit");
            hit.setAttribute("cx", String(x));
            hit.setAttribute("cy", String(y));
            hit.setAttribute("r", String(hitRadius));

            const halo = document.createElementNS(SVG_NS, "circle");
            halo.setAttribute("class", "country-map-marker__halo");
            halo.setAttribute("cx", String(x));
            halo.setAttribute("cy", String(y));
            halo.setAttribute("r", String(radius * 1.65));

            const dot = document.createElementNS(SVG_NS, "circle");
            dot.setAttribute("class", "country-map-marker__dot");
            dot.setAttribute("cx", String(x));
            dot.setAttribute("cy", String(y));
            dot.setAttribute("r", String(radius));

            group.appendChild(hit);
            group.appendChild(halo);
            group.appendChild(dot);

            const activateMarker = (domEvent) => {
                domEvent.preventDefault();
                domEvent.stopPropagation();
                this.navigateToMarkerMeta(meta);
            };

            group.addEventListener("click", (domEvent) => {
                if (
                    group.dataset.coordSpace === "inset-drawer" &&
                    this.isMobileInsetLayout()
                ) {
                    domEvent.preventDefault();
                    domEvent.stopPropagation();
                    this.selectDestination(meta);
                    return;
                }
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
                    if (
                        group.dataset.coordSpace === "inset-drawer" &&
                        this.isMobileInsetLayout()
                    ) {
                        this.selectDestination(meta);
                        return;
                    }
                    if (meta.url) {
                        window.location.href = meta.url;
                    }
                }
            });
            group.addEventListener("focus", () => {
                this.state.hoveredDestination = meta.name;
                this.state.hoveredRegion = meta.region || null;
                group.classList.add("country-map-marker--focused");
                this.setMarkerRadius(group, meta, true);
                this.applyShellState();
                this.showDestinationOverlay(meta);
            });
            group.addEventListener("blur", () => {
                if (this.state.hoveredDestination === meta.name) {
                    this.state.hoveredDestination = null;
                    this.state.hoveredRegion = null;
                    group.classList.remove("country-map-marker--focused");
                    this.setMarkerRadius(group, meta, false);
                    this.applyShellState();
                    this.hideOverlay();
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
            if (this.useExpandedMarkerHit() && this.state.selectedDestination) {
                this.hideOverlay();
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
            this.regionElements.forEach((path) => {
                const regionName = path.dataset.region;
                path.classList.toggle(
                    "country-map-region--active",
                    this.regionHasActiveGuides(regionName),
                );
            });
            this.scheduleBaseCanvasRender();
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

            this.neighborElements.forEach((path) => {
                const isTarget = path.dataset.countryCode === hoveredCountry;
                const hasGuide = path.dataset.hasGuide === "true";
                path.classList.toggle(
                    "country-map-neighbor--highlighted",
                    Boolean(hoveredCountry && isTarget),
                );
                path.classList.toggle(
                    "country-map-neighbor--highlighted-preview",
                    Boolean(hoveredCountry && isTarget && hasGuide),
                );
                path.classList.toggle(
                    "country-map-neighbor--highlighted-static",
                    Boolean(hoveredCountry && isTarget && !hasGuide),
                );
            });

            this.regionElements.forEach((path) => {
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
            this.scheduleBaseCanvasRender();
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
            if (this.useExpandedMarkerHit() && this.state.selectedDestination) {
                this.hideOverlay();
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
                const viewBox = this.svg.getAttribute("viewBox") || this.mapData.viewBox;
            const [, , vbW, vbH] = viewBox.split(/\s+/).map(Number);
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
            this.pendingOverlayPoint = { x: clientX, y: clientY };
            if (this.overlayFrame) {
                return;
            }
            this.overlayFrame = window.requestAnimationFrame(() => {
                this.overlayFrame = null;
                const point = this.pendingOverlayPoint;
                this.pendingOverlayPoint = null;
                if (!point) {
                    return;
                }
                if (this.state.hoveredCountry) {
                    this.placeOverlayFromClient(point.x, point.y);
                } else {
                    this.positionOverlay(point.x, point.y);
                }
            });
        }

        hideOverlay() {
            if (!this.overlay) {
                return;
            }
            this.overlay.classList.remove("country-map-overlay--visible");
            this.overlay.setAttribute("aria-hidden", "true");
            this.pendingOverlayPoint = null;
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
            if (this.state.selectedDestination) {
                this.clearSelectedDestination();
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
            const mapRoot = this.root?.querySelector(".country-map-root");
            if (this.baseCanvas && mapRoot) {
                this.baseCanvasStyle = this.readBaseCanvasStyle(mapRoot);
            }
            this.applyRegionActiveState();
            this.shell?.querySelectorAll(".country-map-marker[data-destination]").forEach((marker) => {
                const meta = this.getMarkerMeta(marker.dataset.destination);
                if (meta) {
                    marker.classList.toggle("country-map-marker--active", meta.active);
                    marker.classList.toggle("country-map-marker--inactive", !meta.active);
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
            if (this.transformFrame) {
                window.cancelAnimationFrame(this.transformFrame);
                this.transformFrame = null;
            }
            if (this.baseCanvasFrame) {
                window.cancelAnimationFrame(this.baseCanvasFrame);
                this.baseCanvasFrame = null;
            }
            if (this.overlayFrame) {
                window.cancelAnimationFrame(this.overlayFrame);
                this.overlayFrame = null;
            }
            if (this.layoutFrame) {
                window.cancelAnimationFrame(this.layoutFrame);
                this.layoutFrame = null;
            }
            this.pendingOverlayPoint = null;
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
            if (this.panelResizeObserver) {
                this.panelResizeObserver.disconnect();
                this.panelResizeObserver = null;
            }
            if (this.renderObserver) {
                this.renderObserver.disconnect();
                this.renderObserver = null;
            }
            if (mapInstance === this) {
                mapInstance = null;
            }
        }
    }

    window.TGCountryMap = {
        async init(options) {
            mapInstance?.destroy();
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
