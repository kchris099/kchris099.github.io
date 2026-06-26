(function () {
    const readTG = () => window.TG || {};

    const findGuideByCountryName = (countryName) => {
        const guides = Object.values(readTG().allCountryGuides || {});
        return guides.find((guide) => guide.name === countryName) || null;
    };

    window.TGActivation = {
        isCountryVisuallyActive(countryName) {
            return Object.values(readTG().availableGuides || {}).some((guide) => guide.name === countryName);
        },

        isCodeVisuallyActive(code) {
            return Boolean((readTG().availableGuides || {})[code]);
        },

        getCountryPageUrl(countryName) {
            const guide = findGuideByCountryName(countryName);
            return guide ? guide.url : null;
        },

        getGuideByCode(code) {
            return (readTG().allCountryGuides || {})[code] || null;
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

        renderCountryListItem(country, continent, countryCodes) {
            const active = this.isCountryVisuallyActive(country);
            const url = this.getCountryPageUrl(country);
            const code = (countryCodes || {})[country] || "xx";

            if (url) {
                const tone = active
                    ? "text-slate-300 hover:text-neon-cyan"
                    : "text-slate-500 hover:text-slate-300";
                const imageClass = active ? "shadow-sm" : "opacity-50";
                return `
                    <a href="${url}" class="flex items-center gap-3 ${tone} transition-colors py-2 group/link text-sm md:text-base">
                        <img src="assets/flags/w20/${code}.png" alt="${country} flag" class="w-5 rounded-[2px] ${imageClass}">
                        <span class="font-medium">${country}</span>
                    </a>
                `;
            }

            return `
                <div class="flex items-center gap-3 text-slate-500 py-2 text-sm md:text-base cursor-not-allowed">
                    <img src="assets/flags/w20/${code}.png" alt="${country} flag" class="w-5 rounded-[2px] opacity-50">
                    <span class="font-medium">${country}</span>
                </div>
            `;
        },

        renderSearchResult(result, countryCodes) {
            const active = this.isCountryVisuallyActive(result.name);
            const url = this.getCountryPageUrl(result.name);
            const code = (countryCodes || {})[result.name] || "xx";

            if (url) {
                const titleClass = active
                    ? "text-white font-medium group-hover:text-neon-cyan transition-colors"
                    : "text-slate-500 font-medium group-hover:text-slate-300 transition-colors";
                const subtitleClass = active ? "text-xs text-slate-500" : "text-xs text-slate-600";
                const imageClass = active ? "w-6 rounded-sm shadow-sm" : "w-6 rounded-sm shadow-sm opacity-50";
                return `
                    <a href="${url}" class="flex items-center justify-between px-6 py-3 hover:bg-deepblue-800/80 transition-colors group">
                        <div class="flex flex-col items-start text-left">
                            <span class="${titleClass}">${result.name}</span>
                            <span class="${subtitleClass}">${result.continent}</span>
                        </div>
                        <img src="assets/flags/w20/${code}.png" alt="flag" class="${imageClass}">
                    </a>
                `;
            }

            return `
                <div class="flex items-center justify-between px-6 py-3 cursor-not-allowed group">
                    <div class="flex flex-col items-start text-left">
                        <span class="text-slate-500 font-medium">${result.name}</span>
                        <span class="text-xs text-slate-600">${result.continent}</span>
                    </div>
                    <img src="assets/flags/w20/${code}.png" alt="flag" class="w-6 rounded-sm shadow-sm opacity-50">
                </div>
            `;
        },

        getTooltipHtml(officialName, regionName, code, countryCodes) {
            const flagUrl = `assets/flags/w40/${code.toLowerCase()}.png`;
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
    };
})();
