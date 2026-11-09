// AI navigation never opens local files, script URLs, embedded documents, or
// application-internal schemes. Trusted UI routes use their own entry points.
export function normalizeBrowserToolUrl(value) {
    if (typeof value !== 'string') return null;
    try {
        const url = new URL(value);
        if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
        if (url.href === 'about:blank') return url.href;
    } catch { /* Invalid URLs are denied before a page is created or navigated. */ }
    return null;
}
