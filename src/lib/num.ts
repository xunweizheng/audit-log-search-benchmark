/**
 * mysql2 returns several numeric MySQL types as JS strings (BIGINT, DECIMAL,
 * sometimes the result of division) to avoid precision loss. Calling toFixed
 * on those throws "x.toFixed is not a function" at runtime — there is no
 * static type error because the rows come back as `unknown` from the driver.
 *
 * Centralize the coercion so every numeric coming out of the DB is normalized
 * before we do arithmetic or formatting on it.
 */

/**
 * Coerce an unknown value to a finite number. Returns the supplied fallback
 * (default 0) when the input is null, undefined or not parseable.
 */
export function toNum(value: unknown, fallback = 0): number {
    if (value === null || value === undefined) return fallback;
    if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
    if (typeof value === 'bigint') return Number(value);
    if (typeof value === 'string') {
        const n = Number(value);
        return Number.isFinite(n) ? n : fallback;
    }
    if (typeof value === 'object') {
        // mysql2's DECIMAL handling can hand back objects with a toString().
        const s = String(value);
        const n = Number(s);
        return Number.isFinite(n) ? n : fallback;
    }
    return fallback;
}

/**
 * Same as toNum but returns null when the value can't be converted, so the
 * caller can distinguish "missing" from "zero".
 */
export function toNumOrNull(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    const n = toNum(value, Number.NaN);
    return Number.isFinite(n) ? n : null;
}
