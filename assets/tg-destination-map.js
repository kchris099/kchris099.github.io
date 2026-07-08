(function initTGDestinationMap() {
    /**
     * Mobile Leaflet guard for destination pages (see country-page-map-playbook.txt §7.8).
     * Call after map.fitBounds: TGDestinationMap.bindMobileScrollGuard(map, 'map');
     */
    const MOBILE_QUERY = "(max-width: 767px)";

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
    };
})();
