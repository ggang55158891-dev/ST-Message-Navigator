/** Pure, bounded panel size preferences. CSS layout and viewport units stay in UI. */
export const PANEL_MIN_WIDTH = 260;
export const PANEL_MIN_HEIGHT = 240;
export const PANEL_MAX_WIDTH = 720;
export const PANEL_MAX_HEIGHT = 1000;

export function validPanelSize(size) {
    return !!size && typeof size === 'object' && !Array.isArray(size) &&
        Object.keys(size).length === 2 &&
        Number.isFinite(size.width) && Number.isFinite(size.height) &&
        size.width >= PANEL_MIN_WIDTH && size.width <= PANEL_MAX_WIDTH &&
        size.height >= PANEL_MIN_HEIGHT && size.height <= PANEL_MAX_HEIGHT;
}

export function fitPanelSize(size, viewportWidth, viewportHeight) {
    const maxWidth = Math.max(1, Math.min(PANEL_MAX_WIDTH, viewportWidth - 24));
    const maxHeight = Math.max(1, Math.min(PANEL_MAX_HEIGHT, viewportHeight - 16));
    const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
    // Screens narrower than the minimum retain usable, non-overflowing width.
    const minWidth = Math.min(PANEL_MIN_WIDTH, maxWidth);
    const minHeight = Math.min(PANEL_MIN_HEIGHT, maxHeight);
    const width = validPanelSize(size) ? size.width : 400;
    const height = validPanelSize(size) ? size.height : Math.min(viewportHeight * 0.84, 850);
    return {
        width: Math.round(clamp(width, minWidth, maxWidth)),
        height: Math.round(clamp(height, minHeight, maxHeight)),
    };
}
