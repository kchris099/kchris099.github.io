(function () {
    const DEV_PORT = 8765;
    const DEV_API_TIMEOUT_MS = 1500;
    const SYNC_CHANNEL_NAME = "tg-destination-activation";

    let apiBase = null;
    let syncChannel = null;
    let config = null;
    let allDestinations = [];

    const normalizeCode = (code) => String(code || "").toUpperCase();

    const isLikelyDevServer = () =>
        location.protocol !== "file:" && location.port === String(DEV_PORT);

    const fetchWithTimeout = async (url, init = {}, timeoutMs = DEV_API_TIMEOUT_MS) => {
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), timeoutMs);
        try {
            return await fetch(url, { ...init, signal: controller.signal });
        } finally {
            window.clearTimeout(timer);
        }
    };

    const apiCandidates = (iso2) => {
        const code = normalizeCode(iso2);
        const bases = [];
        if (location.origin && location.origin !== "null") {
            bases.push(`${location.origin}/__dev__/api/countries/${code}/destinations`);
        }
        if (isLikelyDevServer()) {
            bases.push(`http://127.0.0.1:${DEV_PORT}/__dev__/api/countries/${code}/destinations`);
            bases.push(`http://localhost:${DEV_PORT}/__dev__/api/countries/${code}/destinations`);
        }
        return bases;
    };

    const blacklistApiCandidates = (iso2) => {
        const code = normalizeCode(iso2);
        const bases = [];
        if (location.origin && location.origin !== "null") {
            bases.push(`${location.origin}/__dev__/api/countries/${code}/blacklist`);
        }
        if (isLikelyDevServer()) {
            bases.push(`http://127.0.0.1:${DEV_PORT}/__dev__/api/countries/${code}/blacklist`);
            bases.push(`http://localhost:${DEV_PORT}/__dev__/api/countries/${code}/blacklist`);
        }
        return bases;
    };

    const probeApi = async (iso2, slug) => {
        for (const base of apiCandidates(iso2)) {
            try {
                const response = await fetchWithTimeout(`${base}/${slug}`, {
                    cache: "no-store",
                    mode: "cors",
                });
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

    const writeActivation = async (iso2, slug, active) => {
        if (!apiBase) {
            const hasApi = await probeApi(iso2, slug);
            if (!hasApi) {
                throw new Error("no api");
            }
        }
        const response = await fetchWithTimeout(`${apiBase}/${slug}`, {
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

    const broadcastActivation = (iso2, slug, active) => {
        if (!syncChannel) {
            return;
        }
        syncChannel.postMessage({
            iso2: normalizeCode(iso2),
            slug,
            active,
        });
    };

    window.TGDestinationActivation = {
        hydrateBlacklistFromScript() {
            if (typeof blacklistText === "undefined") {
                return;
            }
            config.blacklist.clear();
            for (const line of String(blacklistText).split("\n")) {
                const trimmed = line.trim();
                if (trimmed && !trimmed.startsWith("#")) {
                    config.blacklist.add(config.normalizeText(trimmed));
                }
            }
        },

        async init(options) {
            config = options;
            allDestinations = [];
            this.bindActivationControls();
            this.initSyncListener();
            this.hydrateBlacklistFromScript();
            this.renderRegionsContainer();
            const syncedFromServer = await this.hydrateBlacklistFromServer();
            if (syncedFromServer) {
                this.renderRegionsContainer();
                this.refreshOpenSearch();
            }
        },

        async hydrateBlacklistFromServer() {
            for (const base of blacklistApiCandidates(config.iso2)) {
                try {
                    const response = await fetchWithTimeout(base, { cache: "no-store", mode: "cors" });
                    if (!response.ok) {
                        continue;
                    }
                    const payload = await response.json();
                    config.blacklist.clear();
                    for (const name of payload.inactive_names || []) {
                        config.blacklist.add(config.normalizeText(name));
                    }
                    return true;
                } catch (_error) {
                    // Try the next candidate.
                }
            }
            return false;
        },

        getBlacklist() {
            return config.blacklist;
        },

        getDestinationSlug(name) {
            return config.destinationPaths[name] || null;
        },

        hasGuide(name) {
            return Boolean(this.getDestinationSlug(name));
        },

        getDestinationStatus(name) {
            if (!this.hasGuide(name)) {
                return "unavailable";
            }
            return config.blacklist.has(config.normalizeText(name)) ? "inactive" : "active";
        },

        isActive(name) {
            return this.getDestinationStatus(name) === "active";
        },

        setActiveInMemory(name, active) {
            const key = config.normalizeText(name);
            if (active) {
                config.blacklist.delete(key);
            } else {
                config.blacklist.add(key);
            }
        },

        getDestinationSortRank(name) {
            const status = this.getDestinationStatus(name);
            if (status === "active") {
                return 0;
            }
            if (status === "inactive") {
                return 1;
            }
            return 2;
        },

        countListedGuides(destinations) {
            return destinations.filter((dest) => this.hasGuide(dest)).length;
        },

        findRegionCard(region) {
            const container = document.getElementById(config.containerId || "regions-container");
            if (!container) {
                return null;
            }
            return Array.from(container.children).find((card) => card.dataset.region === region) || null;
        },

        sortDestinationsForDisplay(destinations) {
            return [...destinations].sort((a, b) => {
                const rankA = this.getDestinationSortRank(a);
                const rankB = this.getDestinationSortRank(b);
                if (rankA !== rankB) {
                    return rankA - rankB;
                }
                return a.localeCompare(b);
            });
        },

        sortRegionKeysForDisplay(regionKeys) {
            return [...regionKeys].sort((a, b) => {
                if (!config.hasRegions) {
                    const rankA = this.getDestinationSortRank(a);
                    const rankB = this.getDestinationSortRank(b);
                    if (rankA !== rankB) {
                        return rankA - rankB;
                    }
                }
                return a.localeCompare(b);
            });
        },

        guideUrl(name) {
            return this.hasGuide(name) ? config.destinationUrl(name) : null;
        },

        renderStatusDot(name) {
            const status = this.getDestinationStatus(name);
            const slug = this.getDestinationSlug(name);
            const toggleable = status !== "unavailable";
            const labels = {
                active: `${name} is active (click to hide)`,
                inactive: `${name} is hidden (click to show)`,
                unavailable: `${name} has no built guide yet`,
            };
            const disabled = toggleable ? "" : " disabled";
            const toggleClass = toggleable ? " country-status-dot--toggleable" : "";
            return `
                <button
                    type="button"
                    class="country-status-dot country-status-dot--${status}${toggleClass}"
                    data-destination-name="${name}"
                    data-destination-slug="${slug || ""}"
                    aria-label="${labels[status]}"
                    title="${labels[status]}"
                    ${disabled}
                ></button>
            `;
        },

        renderDestinationListItem(name) {
            const active = this.isActive(name);
            const url = this.guideUrl(name);
            const statusDot = this.renderStatusDot(name);
            const iconClass = active
                ? "ph ph-map-trifold text-xl text-deepblue-500 group-hover/link:text-neon-yellow transition-colors"
                : "ph ph-map-trifold text-xl opacity-50 text-deepblue-500";
            const tone = active
                ? "text-slate-300 hover:text-neon-yellow"
                : "text-slate-500 hover:text-slate-300";

            if (this.hasGuide(name)) {
                return `
                    <div class="destination-status-row" data-destination-name="${name}">
                        <a href="${url}" class="destination-status-link ${tone} group/link">
                            <i class="${iconClass}"></i>
                            <span class="font-medium truncate">${name}</span>
                        </a>
                        ${statusDot}
                    </div>
                `;
            }

            return `
                <div class="destination-status-row" data-destination-name="${name}">
                    <div class="destination-status-label text-slate-500 cursor-not-allowed">
                        <i class="ph ph-map-trifold text-xl opacity-50 text-deepblue-500"></i>
                        <span class="font-medium truncate">${name}</span>
                    </div>
                    ${statusDot}
                </div>
            `;
        },

        renderDropdownList(region, destinations) {
            const sorted = this.sortDestinationsForDisplay(destinations);
            return sorted
                .map(
                    (dest) =>
                        `<li class="destination-status-item border-b border-deepblue-800/30 last:border-0">${this.renderDestinationListItem(dest)}</li>`,
                )
                .join("");
        },

        renderDirectCard(region, destinations, index) {
            const dest = destinations[0];
            const active = this.isActive(dest);
            const headerClass =
                "w-full px-6 py-5 flex items-center justify-between text-left focus:outline-none focus:bg-deepblue-800/50 hover:bg-deepblue-800/30 transition-colors rounded-2xl relative z-10";
            const icon = "ph-map-pin";
            const iconWrapClass = active
                ? "w-12 h-12 rounded-full bg-gradient-to-br from-deepblue-700 to-deepblue-800 border border-deepblue-700 flex items-center justify-center text-neon-yellow group-hover:scale-110 transition-transform shadow-inner"
                : "w-12 h-12 rounded-full bg-gradient-to-br from-deepblue-800 to-deepblue-900 border border-deepblue-800 flex items-center justify-center text-slate-500 shadow-inner";
            const titleClass = active
                ? "text-xl font-bold text-white tracking-wide"
                : "text-xl font-bold text-slate-500 tracking-wide";
            const sublineClass = active
                ? "text-sm text-slate-400 font-light"
                : "text-sm text-slate-600 font-light";
            const innerHtml = `
                <div class="flex items-center gap-4">
                    <div class="${iconWrapClass}">
                        <i class="ph ${icon} text-2xl"></i>
                    </div>
                    <div>
                        <h2 class="${titleClass}">${region}</h2>
                        <p class="${sublineClass}">Explore Destination &rarr;</p>
                    </div>
                </div>
            `;
            const url = this.guideUrl(dest) || "#";
            const statusDot = this.renderStatusDot(dest);
            const cardStateClass = active
                ? "hover:shadow-[0_0_30px_rgba(255,215,0,0.1)] hover:border-neon-yellow/30"
                : "destination-direct-card--inactive";

            const card = document.createElement("div");
            card.className = `destination-direct-card block bg-deepblue-900/60 border border-deepblue-800 backdrop-blur-sm rounded-2xl relative transition-all duration-300 ${cardStateClass} group`;
            card.dataset.destinationName = dest;
            card.dataset.region = region;
            card.style.animation = `fadeInDown 0.6s ease-out ${index * 0.1 + 0.3}s both`;
            card.style.zIndex = "1";
            card.innerHTML = `
                <div class="destination-direct-card__inner">
                    <a href="${url}" class="destination-direct-card__link ${headerClass}">${innerHtml}</a>
                    ${statusDot}
                </div>
            `;
            return card;
        },

        rebuildAllDestinations() {
            allDestinations = [];
            Object.keys(config.countryData).forEach((region) => {
                config.countryData[region].forEach((name) => {
                    allDestinations.push({
                        name,
                        region,
                        url: this.guideUrl(name) || "#",
                    });
                });
            });
        },

        renderRegionsContainer() {
            const container = document.getElementById(config.containerId || "regions-container");
            if (!container) {
                return;
            }

            container.innerHTML = "";
            this.rebuildAllDestinations();

            this.sortRegionKeysForDisplay(Object.keys(config.countryData)).forEach((region, index) => {
                    const destinations = this.sortDestinationsForDisplay([
                        ...config.countryData[region],
                    ]);
                    const guideCount = this.countListedGuides(destinations);

                    if (!config.hasRegions) {
                        container.appendChild(this.renderDirectCard(region, destinations, index));
                        return;
                    }

                    const card = document.createElement("div");
                    card.className =
                        "bg-deepblue-900/60 border border-deepblue-800 backdrop-blur-sm rounded-2xl relative transition-all duration-300 hover:shadow-[0_0_30px_rgba(255,215,0,0.1)] hover:border-neon-yellow/30 flex flex-col group";
                    card.dataset.region = region;
                    card.style.animation = `fadeInDown 0.6s ease-out ${index * 0.1 + 0.3}s both`;
                    card.style.zIndex = "1";

                    const headerClass =
                        "w-full px-6 py-5 flex items-center justify-between text-left focus:outline-none focus:bg-deepblue-800/50 hover:bg-deepblue-800/30 transition-colors rounded-2xl relative z-10";
                    const icon = config.regionIcons[region] || "ph-map-pin";
                    const innerHtml = `
                        <div class="flex items-center gap-4">
                            <div class="w-12 h-12 rounded-full bg-gradient-to-br from-deepblue-700 to-deepblue-800 border border-deepblue-700 flex items-center justify-center text-neon-yellow group-hover:scale-110 transition-transform shadow-inner">
                                <i class="ph ${icon} text-2xl"></i>
                            </div>
                            <div>
                                <h2 class="text-xl font-bold text-white tracking-wide">${region}</h2>
                                <p class="text-sm text-slate-400 font-light region-active-count">${guideCount} guides</p>
                            </div>
                        </div>
                        <i class="ph ph-caret-down text-xl text-slate-500 transition-transform duration-300 transform dropdown-icon"></i>
                    `;

                    const header = document.createElement("button");
                    header.className = headerClass;
                    header.innerHTML = innerHtml;

                    const body = document.createElement("div");
                    body.className =
                        "dropdown-content absolute top-[calc(100%+8px)] left-0 w-full bg-deepblue-950/95 border border-deepblue-700/80 backdrop-blur-xl rounded-2xl shadow-[0_20px_50px_rgba(0,0,0,0.7)] transition-all duration-300 opacity-0 pointer-events-none translate-y-[-10px] z-50";

                    const list = document.createElement("ul");
                    list.className =
                        "destination-dropdown-list flex flex-col gap-y-1 px-6 py-4 max-h-[350px] overflow-y-auto custom-scrollbar";
                    list.innerHTML = this.renderDropdownList(region, config.countryData[region]);

                    body.appendChild(list);

                    header.addEventListener("click", (event) => {
                        event.stopPropagation();
                        const isOpen = body.classList.contains("opacity-100");
                        document.querySelectorAll(".dropdown-content").forEach((el) => {
                            el.classList.remove("opacity-100", "pointer-events-auto", "translate-y-0");
                            el.classList.add("opacity-0", "pointer-events-none", "translate-y-[-10px]");
                            el.parentElement.style.zIndex = "1";
                        });
                        document.querySelectorAll(".dropdown-icon").forEach((el) =>
                            el.classList.remove("rotate-180", "text-neon-yellow"),
                        );
                        if (!isOpen) {
                            body.classList.remove("opacity-0", "pointer-events-none", "translate-y-[-10px]");
                            body.classList.add("opacity-100", "pointer-events-auto", "translate-y-0");
                            header.querySelector(".dropdown-icon").classList.add("rotate-180", "text-neon-yellow");
                            card.style.zIndex = "50";
                        }
                    });

                    body.addEventListener("click", (event) => event.stopPropagation());
                    card.appendChild(header);
                    card.appendChild(body);
                    container.appendChild(card);
                });

            if (!this._documentClickBound) {
                this._documentClickBound = true;
                document.addEventListener("click", () => {
                    document.querySelectorAll(".dropdown-content").forEach((el) => {
                        el.classList.remove("opacity-100", "pointer-events-auto", "translate-y-0");
                        el.classList.add("opacity-0", "pointer-events-none", "translate-y-[-10px]");
                        el.parentElement.style.zIndex = "1";
                    });
                    document.querySelectorAll(".dropdown-icon").forEach((el) =>
                        el.classList.remove("rotate-180", "text-neon-yellow"),
                    );
                });
            }
        },

        refreshRegionDropdown(region) {
            const card = this.findRegionCard(region);
            const list = card?.querySelector(".destination-dropdown-list");
            if (!list) {
                return;
            }
            list.innerHTML = this.renderDropdownList(region, config.countryData[region]);
            const countEl = card?.querySelector(".region-active-count");
            if (countEl) {
                const guideCount = this.countListedGuides(config.countryData[region]);
                countEl.textContent = `${guideCount} guides`;
            }
        },

        refreshDirectCard(name) {
            const card = document.querySelector(`.destination-direct-card[data-destination-name="${name}"]`);
            if (!card) {
                return;
            }
            const region = card.dataset.region || name;
            const index = Array.from(card.parentElement?.children || []).indexOf(card);
            const newCard = this.renderDirectCard(region, [name], Math.max(index, 0));
            card.replaceWith(newCard);
        },

        refreshOpenSearch() {
            const input = document.getElementById("search-input");
            if (input && input.value.trim()) {
                input.dispatchEvent(new Event("input", { bubbles: true }));
            }
        },

        applyActivationChange(name, active) {
            this.setActiveInMemory(name, active);
            this.rebuildAllDestinations();

            const region = Object.keys(config.countryData).find((key) =>
                config.countryData[key].includes(name),
            );
            if (config.hasRegions && region) {
                this.refreshRegionDropdown(region);
            } else if (!config.hasRegions) {
                this.renderRegionsContainer();
            } else {
                Object.keys(config.countryData).forEach((regionName) => {
                    if (config.countryData[regionName].includes(name)) {
                        this.refreshRegionDropdown(regionName);
                    }
                });
            }
            this.refreshOpenSearch();
        },

        async toggleDestination(name) {
            const slug = this.getDestinationSlug(name);
            if (!slug || this.getDestinationStatus(name) === "unavailable") {
                return false;
            }

            const previousActive = this.isActive(name);
            const nextActive = !previousActive;
            this.applyActivationChange(name, nextActive);

            try {
                const confirmed = await writeActivation(config.iso2, slug, nextActive);
                if (confirmed !== nextActive) {
                    this.applyActivationChange(name, confirmed);
                }
                broadcastActivation(config.iso2, slug, confirmed);
                return confirmed;
            } catch (error) {
                this.applyActivationChange(name, previousActive);
                throw error;
            }
        },

        bindActivationControls(root) {
            const scope = root || document;
            scope.addEventListener(
                "click",
                async (event) => {
                    const button = event.target.closest(".country-status-dot--toggleable");
                    if (!button || button.disabled || button.classList.contains("country-status-dot--busy")) {
                        return;
                    }
                    const name = button.dataset.destinationName;
                    if (!name) {
                        return;
                    }
                    event.preventDefault();
                    event.stopPropagation();

                    button.classList.add("country-status-dot--busy");
                    try {
                        await this.toggleDestination(name);
                    } catch (error) {
                        button.classList.add("country-status-dot--error");
                        window.setTimeout(() => button.classList.remove("country-status-dot--error"), 900);
                        const message = error instanceof Error ? error.message : "toggle failed";
                        if (message.includes("no api")) {
                            button.title = "Start serve-dev.bat to toggle destinations locally.";
                        } else {
                            button.title = message;
                        }
                        console.warn(`Destination toggle failed for ${name}:`, message);
                    } finally {
                        button.classList.remove("country-status-dot--busy");
                    }
                },
                true,
            );
        },

        initSyncListener() {
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
                const slug = event.data?.slug;
                if (!iso2 || !slug || typeof event.data?.active !== "boolean") {
                    return;
                }
                if (iso2 !== normalizeCode(config.iso2)) {
                    return;
                }
                const name = Object.entries(config.destinationPaths).find(([, value]) => value === slug)?.[0];
                if (!name) {
                    return;
                }
                const currentlyActive = this.isActive(name);
                if (currentlyActive !== event.data.active) {
                    this.applyActivationChange(name, event.data.active);
                }
            });
        },

        setupSearch() {
            const searchInput = document.getElementById("search-input");
            const searchResults = document.getElementById("search-results");
            const searchResultsList = document.getElementById("search-results-list");
            if (!searchInput || !searchResults || !searchResultsList) {
                return;
            }

            const renderResults = (results) => {
                searchResultsList.innerHTML = "";
                if (results.length === 0) {
                    searchResultsList.innerHTML =
                        '<li class="px-6 py-4 text-slate-400 text-center">No guides found.</li>';
                } else {
                    results.forEach((result) => {
                        const item = document.createElement("li");
                        if (this.isActive(result.name)) {
                            item.innerHTML = `<a href="${result.url}" class="flex items-center justify-between px-6 py-3 hover:bg-deepblue-800/80 transition-colors group"><div class="flex flex-col"><span class="text-white font-medium group-hover:text-neon-cyan transition-colors">${result.name}</span><span class="text-xs text-slate-500">${result.region}</span></div><i class="ph ph-arrow-right text-slate-600 group-hover:text-neon-cyan group-hover:translate-x-1 transition-all"></i></a>`;
                        } else if (this.hasGuide(result.name)) {
                            item.innerHTML = `<a href="${result.url}" class="flex items-center justify-between px-6 py-3 hover:bg-deepblue-800/50 transition-colors group"><div class="flex flex-col"><span class="text-slate-500 font-medium group-hover:text-slate-300 transition-colors">${result.name}</span><span class="text-xs text-slate-600">${result.region}</span></div><i class="ph ph-arrow-right opacity-50 text-slate-600 group-hover:text-slate-400 group-hover:translate-x-1 transition-all"></i></a>`;
                        } else {
                            item.innerHTML = `<div class="flex items-center justify-between px-6 py-3 cursor-not-allowed group"><div class="flex flex-col"><span class="text-slate-500 font-medium">${result.name}</span><span class="text-xs text-slate-600">${result.region}</span></div><i class="ph ph-arrow-right opacity-50 text-slate-600"></i></div>`;
                        }
                        searchResultsList.appendChild(item);
                    });
                }
                searchResults.classList.remove("hidden");
            };

            searchInput.addEventListener("input", (event) => {
                const query = config.normalizeText(event.target.value.trim());
                if (!query) {
                    searchResults.classList.add("hidden");
                    return;
                }
                let filtered = allDestinations.filter((dest) =>
                    config.normalizeText(dest.name).includes(query),
                );
                filtered.sort((a, b) => {
                    const rankA = this.getDestinationSortRank(a.name);
                    const rankB = this.getDestinationSortRank(b.name);
                    if (rankA !== rankB) {
                        return rankA - rankB;
                    }
                    return a.name.localeCompare(b.name);
                });
                renderResults(filtered.slice(0, 8));
            });

            document.addEventListener("click", (event) => {
                if (!searchInput.contains(event.target) && !searchResults.contains(event.target)) {
                    searchResults.classList.add("hidden");
                }
            });

            searchInput.addEventListener("focus", () => {
                if (searchInput.value.trim()) {
                    searchResults.classList.remove("hidden");
                }
            });
        },
    };

    if (typeof BroadcastChannel !== "undefined") {
        syncChannel = new BroadcastChannel(SYNC_CHANNEL_NAME);
    }
})();
