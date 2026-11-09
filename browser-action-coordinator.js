export const MUTATING_BROWSER_TOOLS = new Set([
    'open_tab',
    'focus_tab',
    'close_tab',
    'cleanup_task_tabs',
    'navigate_tab',
    'click_element',
    'press_and_hold',
    'type_into',
    'scroll_page',
    'search_site',
    'create_transformed_view',
    'update_transformed_view',
    'open_transformed_view',
    'refresh_transformed_view'
]);

function cancellationResult(toolName, started, reason = 'Browser action was cancelled.') {
    const mutation = MUTATING_BROWSER_TOOLS.has(toolName);
    return {
        ok: false,
        error: {
            code: 'browser_action_cancelled',
            message: reason,
            retryable: !mutation
        },
        actionMayHaveCompleted: mutation && started
    };
}

function lockResult(owner) {
    return {
        ok: false,
        error: {
            code: 'browser_control_locked',
            message: `${owner === 'assistant' ? 'The OpenCode terminal' : 'The in-browser assistant'} currently has exclusive browser control.`,
            retryable: true
        }
    };
}

/**
 * Coordinates browser actions across the legacy assistant and the OpenCode
 * bridge. Mutations are serialized per application tab; harmless reads may
 * run concurrently up to a small, bounded limit.
 */
export default class BrowserActionCoordinator {
    constructor({ maxConcurrentReads = 4 } = {}) {
        this.maxConcurrentReads = maxConcurrentReads;
        this.exclusiveOwner = null;
        this.mutationTails = new Map();
        this.readQueue = [];
        this.activeReads = 0;
        this.ownerControllers = new Map();
    }

    setExclusiveOwner(owner) {
        this.exclusiveOwner = owner || null;
        if (owner) {
            for (const knownOwner of this.ownerControllers.keys()) {
                if (knownOwner !== owner) {
                    this.cancelOwner(knownOwner, `${owner === 'opencode' ? 'OpenCode' : 'The in-browser assistant'} took browser control.`);
                }
            }
        }
    }

    clearExclusiveOwner(owner) {
        if (!owner || this.exclusiveOwner === owner) {
            this.exclusiveOwner = null;
        }
    }

    cancelOwner(owner, reason = 'Browser action was cancelled.') {
        const controllers = this.ownerControllers.get(owner);
        if (!controllers) return;
        for (const controller of controllers) {
            if (!controller.signal.aborted) {
                controller.abort(reason);
            }
        }
    }

    execute({ owner, toolName, tabId, signal, onStart }, operation) {
        if (this.exclusiveOwner && this.exclusiveOwner !== owner) {
            return Promise.resolve(lockResult(owner));
        }

        const task = { owner, toolName, signal, onStart, operation, started: false };
        if (!MUTATING_BROWSER_TOOLS.has(toolName)) {
            return this.enqueueRead(task);
        }

        // Tab creation and focus affect global browser state. Other mutations
        // can progress independently when they target different tabs.
        const key = toolName === 'open_tab' || toolName === 'focus_tab'
            ? '__browser__'
            : String(tabId || '__browser__');
        return this.enqueueMutation(key, task);
    }

    enqueueMutation(key, task) {
        const previous = this.mutationTails.get(key) || Promise.resolve();
        const current = previous
            .catch(() => undefined)
            .then(() => this.runTask(task));
        const tail = current.catch(() => undefined);
        this.mutationTails.set(key, tail);
        tail.finally(() => {
            if (this.mutationTails.get(key) === tail) {
                this.mutationTails.delete(key);
            }
        });
        return current;
    }

    enqueueRead(task) {
        return new Promise((resolve, reject) => {
            this.readQueue.push({ task, resolve, reject });
            this.drainReads();
        });
    }

    drainReads() {
        while (this.activeReads < this.maxConcurrentReads && this.readQueue.length > 0) {
            const next = this.readQueue.shift();
            this.activeReads += 1;
            this.runTask(next.task)
                .then(next.resolve, next.reject)
                .finally(() => {
                    this.activeReads -= 1;
                    this.drainReads();
                });
        }
    }

    async runTask(task) {
        if (task.signal?.aborted) {
            return cancellationResult(task.toolName, false, String(task.signal.reason || 'Browser action was cancelled.'));
        }
        if (this.exclusiveOwner && this.exclusiveOwner !== task.owner) {
            return lockResult(task.owner);
        }

        const controller = new AbortController();
        const ownerControllers = this.ownerControllers.get(task.owner) || new Set();
        ownerControllers.add(controller);
        this.ownerControllers.set(task.owner, ownerControllers);

        const forwardAbort = () => controller.abort(task.signal?.reason || 'Browser action was cancelled.');
        task.signal?.addEventListener('abort', forwardAbort, { once: true });

        try {
            if (controller.signal.aborted) {
                return cancellationResult(task.toolName, false, String(controller.signal.reason || 'Browser action was cancelled.'));
            }
            task.started = true;
            task.onStart?.();
            const result = await task.operation({ signal: controller.signal });
            if (controller.signal.aborted) {
                return cancellationResult(task.toolName, true, String(controller.signal.reason || 'Browser action was cancelled.'));
            }
            return result;
        } finally {
            task.signal?.removeEventListener('abort', forwardAbort);
            ownerControllers.delete(controller);
            if (ownerControllers.size === 0) {
                this.ownerControllers.delete(task.owner);
            }
        }
    }
}

export { cancellationResult as browserActionCancellationResult };
