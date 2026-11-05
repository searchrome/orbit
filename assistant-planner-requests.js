const activeAssistantPlannerRequests = new Map();

function registerAssistantPlannerRequest({ requestId, sessionId, controller, timeoutId }) {
    if (!requestId) {
        throw new Error('assistant-next-action requires a requestId.');
    }

    const previous = activeAssistantPlannerRequests.get(requestId);
    if (previous?.controller && previous.controller !== controller) {
        previous.controller.abort(new Error('Replaced by a newer planner request.'));
    }
    if (previous?.timeoutId) {
        clearTimeout(previous.timeoutId);
    }

    activeAssistantPlannerRequests.set(requestId, {
        sessionId,
        controller,
        timeoutId
    });
}

function clearAssistantPlannerRequest(requestId, controller) {
    if (!requestId) {
        return false;
    }

    const current = activeAssistantPlannerRequests.get(requestId);
    if (!current) {
        return false;
    }

    if (!controller || current.controller === controller) {
        if (current.timeoutId) {
            clearTimeout(current.timeoutId);
        }
        activeAssistantPlannerRequests.delete(requestId);
        return true;
    }

    return false;
}

function abortAssistantPlannerRequest(requestId, reason = new Error('Assistant task stopped by the user.')) {
    if (!requestId) {
        return false;
    }

    const active = activeAssistantPlannerRequests.get(requestId);
    if (!active) {
        return false;
    }

    active.controller.abort(reason);
    return true;
}

function resetAssistantPlannerRequests() {
    for (const request of activeAssistantPlannerRequests.values()) {
        if (request.timeoutId) {
            clearTimeout(request.timeoutId);
        }
    }
    activeAssistantPlannerRequests.clear();
}

module.exports = {
    activeAssistantPlannerRequests,
    registerAssistantPlannerRequest,
    clearAssistantPlannerRequest,
    abortAssistantPlannerRequest,
    resetAssistantPlannerRequests
};
