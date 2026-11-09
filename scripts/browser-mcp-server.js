#!/usr/bin/env node

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const z = require('zod');
const BrowserTaskLifecycle = require('../browser-task-lifecycle');

const endpoint = String(process.env.BROWSER_REMOTE_URL || '');
const token = String(process.env.BROWSER_REMOTE_TOKEN || '');
const artifactEndpoint = String(process.env.ARTIFACT_REMOTE_URL || '');
const artifactToken = String(process.env.ARTIFACT_REMOTE_TOKEN || '');

if (!endpoint || !token) {
    process.stderr.write('Browser MCP server requires BROWSER_REMOTE_URL and BROWSER_REMOTE_TOKEN.\n');
    process.exit(1);
}

function textResult(value, isError = false) {
    return {
        content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        ...(isError ? { isError: true } : {})
    };
}

async function callBrowser(tool, args) {
    let response;
    try {
        response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-browser-remote-token': token
            },
            body: JSON.stringify({ tool, args }),
            signal: AbortSignal.timeout(35_000)
        });
    } catch (error) {
        return {
            ok: false,
            error: { code: 'bridge_unavailable', message: error?.message || String(error), retryable: true }
        };
    }

    try {
        const body = await response.json();
        if (!response.ok && body?.ok !== false) {
            return { ok: false, error: { code: 'bridge_http_error', message: `Browser bridge returned HTTP ${response.status}.` } };
        }
        return body;
    } catch (error) {
        return { ok: false, error: { code: 'invalid_bridge_response', message: error?.message || String(error), retryable: true } };
    }
}

async function callArtifact(tool, args) {
    if (!artifactEndpoint || !artifactToken) {
        return { ok: false, error: { code: 'artifact_bridge_unavailable', message: 'The artifact service is unavailable.', retryable: true } };
    }
    try {
        const response = await fetch(artifactEndpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-artifact-token': artifactToken },
            body: JSON.stringify({ tool, args }),
            signal: AbortSignal.timeout(35_000)
        });
        const body = await response.json();
        return body;
    } catch (error) {
        return { ok: false, error: { code: 'artifact_bridge_unavailable', message: error?.message || String(error), retryable: true } };
    }
}

function browserTool(name, description, inputSchema) {
    server.registerTool(name, { description, inputSchema }, async (args) => {
        const result = name === 'open_tab' ? await taskLifecycle.open(args) : await callBrowser(name, args);
        return textResult(result, result?.ok === false);
    });
}

function artifactTool(name, description, inputSchema) {
    server.registerTool(name, { description, inputSchema }, async (args) => {
        const result = await callArtifact(name, args);
        return textResult(result, result?.ok === false);
    });
}

const tabId = z.string().min(1).max(200);
const selector = z.string().min(1).max(1_000);
const transformedViewId = z.string().uuid();
const transformedRecipe = z.object({
    rootSelector: selector,
    titleSelector: z.string().max(1_000).optional(),
    readySelector: z.string().max(1_000).optional(),
    removeSelectors: z.array(selector).max(40).optional(),
    theme: z.enum(['light', 'dark']).optional()
});
const optionalTimeout = z.number().int().min(500).max(20_000).optional();
const batchReadRequest = z.object({
    id: z.string().min(1).max(80),
    tool: z.enum(['get_tab_info', 'read_page_text', 'find_page_text', 'query_selector_all']),
    args: z.object({ tabId }).passthrough()
});
const server = new McpServer({ name: 'simple-electron-browser', version: '1.0.0' });
const taskLifecycle = new BrowserTaskLifecycle(callBrowser);

server.registerTool('begin_task', {
    description: 'Begin a new user task before opening research tabs. Task tabs are tracked automatically; existing user tabs are never adopted.',
    inputSchema: {}
}, async () => {
    const result = await taskLifecycle.begin();
    return textResult(result, result.ok === false);
});
server.registerTool('complete_task', {
    description: 'Call after verifying the final result and before your final answer. Closes only research tabs opened by this task. Preserves existing user tabs, artifact/result tabs, live-artifact source tabs, and explicit keepTabIds. Report any cleanup failure instead of claiming all tabs were closed.',
    inputSchema: {keepTabIds: z.array(tabId).max(500).optional()}
}, async args => {
    const result = await taskLifecycle.complete(args);
    return textResult(result, result?.ok === false);
});

browserTool('list_tabs', 'List the browser’s visible tabs. Use this before acting so tab IDs come from the current browser state.', {});
browserTool('get_active_tab', 'Get the tab selected in the browser UI.', {});
browserTool('get_tab_info', 'Get the current URL and metadata for one visible browser tab.', { tabId });
browserTool('open_tab', 'Open a visible browser tab and return its application tab ID.', {
    url: z.string().url().max(8_192),
    title: z.string().max(250).optional(),
    activate: z.boolean().optional()
});
browserTool('focus_tab', 'Select a visible tab in the browser UI.', { tabId });
browserTool('close_tab', 'Close a visible browser tab. Do not close a tab unless the user asks or it is an agent-created temporary tab.', { tabId });
browserTool('navigate_tab', 'Navigate a visible browser tab to a URL and wait for it to be ready.', { tabId, url: z.string().url().max(8_192), timeoutMs: optionalTimeout });
browserTool('wait_for_load', 'Wait for a tab to finish loading.', { tabId, timeoutMs: optionalTimeout });
browserTool('wait_for_element', 'Wait without changing the page until a specific element is present, visible, enabled, removed, or has expected text. This follows navigation within the same tab and does not wait for background network traffic.', {
    tabId,
    selector,
    index: z.number().int().min(0).max(100).optional(),
    present: z.boolean().optional(),
    visible: z.boolean().optional(),
    enabled: z.boolean().optional(),
    text: z.string().min(1).max(512).optional(),
    textChangedFrom: z.string().max(512).optional(),
    caseSensitive: z.boolean().optional(),
    timeoutMs: optionalTimeout,
    pollIntervalMs: z.number().int().min(50).max(1_000).optional()
});
browserTool('batch_read_tabs', 'Read several tabs concurrently through allowlisted inspection tools. Every request needs a stable id and tabId; results retain that id and the document that produced them. Total serialized output is bounded.', {
    requests: z.array(batchReadRequest).min(1).max(8),
    maxOutputChars: z.number().int().min(10_000).max(64_000).optional()
});
browserTool('read_page_text', 'Read bounded visible page text from a browser tab. Optional selector or contentMode main/article/auto targets a semantic region without changing the page.', {
    tabId,
    maxChars: z.number().int().min(1).max(20_000).optional(),
    selector: z.string().min(1).max(1_000).optional(),
    contentMode: z.enum(['full', 'main', 'article', 'auto']).optional()
});
browserTool('find_page_text', 'Find literal text in the main rendered document without changing selection, scroll position, or native find state. Matching is case-insensitive by default; subframes are not searched.', {
    tabId,
    query: z.string().min(1).max(512),
    contextChars: z.number().int().min(0).max(512).optional(),
    maxMatches: z.number().int().min(1).max(50).optional(),
    caseSensitive: z.boolean().optional()
});
browserTool('query_selector_all', 'Read selected elements from a browser tab. Keep selectors specific and inspect results before clicking.', {
    tabId,
    selector,
    fields: z.array(z.enum(['text', 'href', 'title', 'ariaLabel'])).max(4).optional(),
    offset: z.number().int().min(0).max(1_000_000).optional(),
    maxResults: z.number().int().min(1).max(200).optional(),
    maxTextChars: z.number().int().min(1).max(20_000).optional(),
    textOffset: z.number().int().min(0).max(1_000_000).optional(),
    maxOutputChars: z.number().int().min(256).max(64_000).optional(),
    compact: z.boolean().optional()
});
browserTool('click_element', 'Click one matched element in a tab. Confirm with the user before actions that submit, buy, send, delete, or change an account.', {
    tabId,
    selector,
    index: z.number().int().min(0).max(100).optional()
});
browserTool('type_into', 'Type text into an element in a browser tab. Set submit only after the user has asked to send or search.', {
    tabId,
    selector,
    text: z.string().max(10_000).optional(),
    submit: z.boolean().optional(),
    clear: z.boolean().optional()
});
browserTool('scroll_page', 'Scroll one browser tab.', {
    tabId,
    direction: z.enum(['up', 'down']).optional(),
    amount: z.number().int().min(1).max(8_000).optional()
});
browserTool('search_site', 'Use a site’s visible search box in a browser tab.', {
    tabId,
    query: z.string().min(1).max(2_000),
    siteHint: z.string().max(250).optional(),
    timeoutMs: optionalTimeout
});
browserTool('extract_search_results', 'Extract structured search results from a browser tab after inspecting its content.', {
    tabId,
    siteHint: z.string().max(250).optional()
});
browserTool('create_transformed_view', 'Create and open a saved local reader or redesigned view. Inspect the source first, then provide stable selectors. The view refreshes from current source content without another model call.', {
    name: z.string().min(1).max(160),
    sourceUrl: z.string().url().max(8_192),
    recipe: transformedRecipe
});
browserTool('update_transformed_view', 'Update a saved transformed view using the revision returned by list_transformed_views. Use this only when the user asks to rebuild or change its design.', {
    id: transformedViewId,
    expectedRevision: z.number().int().min(1),
    name: z.string().min(1).max(160).optional(),
    sourceUrl: z.string().url().max(8_192).optional(),
    recipe: transformedRecipe.optional()
});
browserTool('list_transformed_views', 'List saved OpenCode-created transformed views, including source URLs, recipes, and revisions.', {});
browserTool('open_transformed_view', 'Open a saved transformed view in a browser tab and refresh it from current source content.', { id: transformedViewId });
browserTool('refresh_transformed_view', 'Refresh one open transformed-view tab from its source. This does not call the model or create another artifact.', { tabId });
artifactTool('create_artifact', 'Create a UTF-8 text artifact in the app-owned workspace. Pass content directly as text; never base64-encode HTML, CSV, Markdown, JSON, or reports. HTML opens as an interactive sandboxed page, while other text files open in a safe preview and can be downloaded.', {
    name: z.string().min(1).max(180),
    content: z.string().min(1).max(2_000_000),
    contentType: z.string().max(120).optional()
});
artifactTool('list_artifacts', 'List files created during this browser session, including safe preview and download URLs.', {});
const dynamicPackage = {
    name: z.string().min(1).max(180),
    html: z.string().min(1).max(500000),
    sources: z.array(z.object({ id: z.string().min(1).max(80), url: z.string().url().max(8192), kind: z.enum(['text', 'elements']), selector: z.string().max(1000).optional() })).max(6)
};
artifactTool('get_dynamic_artifact_guide', 'Read the dynamic app framework instructions and working starter HTML before creating an app.', {});
artifactTool('create_dynamic_artifact', 'Create a persistent dynamic web artifact using the shared server, SQLite storage and artifact JavaScript SDK. Read the guide first.', dynamicPackage);
artifactTool('get_dynamic_artifact', 'Read a dynamic app package, revision, refresh status and source snapshot before editing.', { id: z.string().uuid() });
artifactTool('update_dynamic_artifact', 'Replace a dynamic app package using its expected revision, preserving storage and settings. Reopen the app to load changed code.', { id: z.string().uuid(), expectedRevision: z.number().int().min(1), ...dynamicPackage });
artifactTool('open_artifact', 'Open a previously created artifact in a visible sandboxed browser tab. HTML is interactive; text files have a safe preview and other files offer a download link.', { id: z.string().uuid() });
artifactTool('download_artifact', 'After user approval, download a previously created artifact of any file type through a visible browser tab.', { id: z.string().uuid() });

async function main() {
    await server.connect(new StdioServerTransport());
}

main().catch((error) => {
    process.stderr.write(`Browser MCP server failed: ${error?.stack || error}\n`);
    process.exit(1);
});
