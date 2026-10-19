// Pure geometry; Shell coordinates are logical pixels, not physical pixels.
export function splitHorizontal(area) {
    for (const key of ['x', 'y', 'width', 'height']) {
        if (!Number.isSafeInteger(area[key]))
            throw new Error(`Invalid work area: ${key}`);
    }
    if (area.width < 2 || area.height < 1)
        throw new Error('Work area is too small');

    const width = Math.floor(area.width / 2);
    return [
        {x: area.x, y: area.y, width, height: area.height},
        {x: area.x + width, y: area.y,
            width: area.width - width, height: area.height},
    ];
}

export function rectMatches(actual, expected, tolerance = 2) {
    return ['x', 'y', 'width', 'height'].every(key =>
        Math.abs(actual[key] - expected[key]) <= tolerance);
}
