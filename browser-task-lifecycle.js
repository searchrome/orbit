const { randomUUID } = require('node:crypto');

// One MCP process owns one current task. Serialize opens and completion so an
// in-flight open cannot arrive after cleanup and become an untracked tab.
class BrowserTaskLifecycle {
    constructor(callBrowser) {
        this.callBrowser = callBrowser;
        this.taskId = null;
        this.pending = Promise.resolve();
    }
    run(operation) {
        const result = this.pending.then(operation);
        this.pending = result.catch(() => {});
        return result;
    }
    begin() {
        return this.run(() => {
            if (this.taskId) return {ok: false, error: {code: 'task_already_active', message: 'Complete the current task before beginning another.'}};
            this.taskId = randomUUID();
            return {ok: true, data: {started: true}};
        });
    }
    open(args) {
        return this.run(() => {
            this.taskId ||= randomUUID();
            return this.callBrowser('open_tab', {...args, _taskId: this.taskId});
        });
    }
    complete({keepTabIds = []} = {}) {
        return this.run(async () => {
            if (!this.taskId) return {ok: true, data: {closedTabIds: [], keptTabs: []}};
            const result = await this.callBrowser('cleanup_task_tabs', {taskId: this.taskId, keepTabIds});
            if (result?.ok) this.taskId = null;
            return result;
        });
    }
}
module.exports = BrowserTaskLifecycle;
