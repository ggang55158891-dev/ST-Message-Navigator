/** Pure geometry for a draggable navigator. Positions are viewport-relative. */
const EDGE = 6;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function validNavPosition(position) {
    return !!position && typeof position === 'object' &&
        Number.isFinite(position.x) && position.x >= 0 && position.x <= 1 &&
        Number.isFinite(position.y) && position.y >= 0 && position.y <= 1;
}

export function constrainNavPosition(left, centerY, width, height, navWidth, navHeight) {
    const xMax = Math.max(EDGE, width - navWidth - EDGE);
    const yMin = Math.min(height / 2, navHeight / 2 + EDGE);
    const yMax = Math.max(yMin, height - navHeight / 2 - EDGE);
    return {
        left: clamp(left, EDGE, xMax),
        centerY: clamp(centerY, yMin, yMax),
    };
}

export function toRelativeNavPosition(left, centerY, width, height, navWidth, navHeight) {
    const point = constrainNavPosition(left, centerY, width, height, navWidth, navHeight);
    const availableX = Math.max(0, width - navWidth - 2 * EDGE);
    const availableY = Math.max(0, height - navHeight - 2 * EDGE);
    return {
        x: availableX ? clamp((point.left - EDGE) / availableX, 0, 1) : 0.5,
        y: availableY ? clamp((point.centerY - navHeight / 2 - EDGE) / availableY, 0, 1) : 0.5,
    };
}

export function fromRelativeNavPosition(position, width, height, navWidth, navHeight) {
    if (!validNavPosition(position)) return null;
    const availableX = Math.max(0, width - navWidth - 2 * EDGE);
    const availableY = Math.max(0, height - navHeight - 2 * EDGE);
    return constrainNavPosition(
        EDGE + position.x * availableX,
        navHeight / 2 + EDGE + position.y * availableY,
        width, height, navWidth, navHeight,
    );
}
