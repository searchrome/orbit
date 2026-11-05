const {
    activeAssistantPlannerRequests,
    registerAssistantPlannerRequest,
    clearAssistantPlannerRequest,
    abortAssistantPlannerRequest,
    resetAssistantPlannerRequests
} = require('../../assistant-planner-requests.js');

describe('assistant planner request registry', () => {
    beforeEach(() => {
        resetAssistantPlannerRequests();
    });

    afterEach(() => {
        resetAssistantPlannerRequests();
    });

    test('aborts only the matching request id even when sessions overlap', () => {
        const firstController = {
            abort: jest.fn()
        };
        const secondController = {
            abort: jest.fn()
        };

        registerAssistantPlannerRequest({
            requestId: 'request-a',
            sessionId: 'session-1',
            controller: firstController,
            timeoutId: 11
        });
        registerAssistantPlannerRequest({
            requestId: 'request-b',
            sessionId: 'session-1',
            controller: secondController,
            timeoutId: 22
        });

        expect(abortAssistantPlannerRequest('request-a')).toBe(true);
        expect(firstController.abort).toHaveBeenCalledTimes(1);
        expect(secondController.abort).not.toHaveBeenCalled();
        expect(activeAssistantPlannerRequests.has('request-a')).toBe(true);
        expect(activeAssistantPlannerRequests.has('request-b')).toBe(true);

        expect(clearAssistantPlannerRequest('request-a', firstController)).toBe(true);
        expect(activeAssistantPlannerRequests.has('request-a')).toBe(false);
        expect(activeAssistantPlannerRequests.has('request-b')).toBe(true);
    });
});
