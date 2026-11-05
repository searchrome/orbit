// Unit tests for the OpenRouter-backed AI service.

describe('OpenRouter service', () => {
  let service;
  let fetchMock;

  function setBaseEnv() {
    process.env.NODE_ENV = 'test';
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
    process.env.OPENROUTER_MODEL = 'test-model';
    process.env.OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
    process.env.OPENROUTER_HTTP_REFERER = 'http://localhost/test';
    process.env.OPENROUTER_APP_TITLE = 'Browser Test';
  }

  function clearBaseEnv() {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_MODEL;
    delete process.env.OPENROUTER_BASE_URL;
    delete process.env.OPENROUTER_HTTP_REFERER;
    delete process.env.OPENROUTER_APP_TITLE;
  }

  function loadService() {
    jest.resetModules();
    return require('../../openrouter-service');
  }

  function mockChatResponse(content, { ok = true, status = 200, payload } = {}) {
    fetchMock.mockResolvedValue({
      ok,
      status,
      text: jest.fn().mockResolvedValue(
        payload ? JSON.stringify(payload) : JSON.stringify({
          choices: [
            {
              message: {
                content,
              },
            },
          ],
        })
      ),
    });
  }

  beforeEach(() => {
    clearBaseEnv();
    setBaseEnv();
    fetchMock = jest.fn();
    global.fetch = fetchMock;
    service = loadService();
  });

  afterEach(() => {
    clearBaseEnv();
    delete global.fetch;
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('getGeminiSummary should return a summary from OpenRouter', async () => {
    mockChatResponse('Mock OpenRouter summary');

    const textContent = 'This is some sample content to summarize';
    const summary = await service.getGeminiSummary(textContent);

    expect(summary).toBe('Mock OpenRouter summary');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-openrouter-key',
          'HTTP-Referer': 'http://localhost/test',
          'X-OpenRouter-Title': 'Browser Test',
        }),
      })
    );

    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(requestBody.model).toBe('test-model');
    expect(requestBody.messages[1].content).toContain(textContent);
  });

  test('getGeminiSummary should truncate long content', async () => {
    mockChatResponse('Mock OpenRouter summary');

    const longContent = 'a'.repeat(50000);
    await service.getGeminiSummary(longContent);

    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(requestBody.messages[1].content).toContain('a'.repeat(30000));
  });

  test('creates searchable bookmark metadata with the selected OpenRouter model', async () => {
    mockChatResponse(JSON.stringify({
      definition: 'A report explaining browser automation safety.',
      summary: 'The report covers permissions, crash recovery, and controlled browser actions.',
      keywords: ['browser automation', 'crash recovery']
    }));

    const enrichment = await service.getBookmarkEnrichment({
      title: 'Browser safety report',
      url: 'https://example.com/report',
      content: 'A detailed report about browser automation safety and crash recovery.'
    }, {
      model: 'z-ai/glm-5.3-flash',
      openRouterConfig: { apiKey: 'saved-ui-key' }
    });

    expect(enrichment).toEqual({
      definition: 'A report explaining browser automation safety.',
      summary: 'The report covers permissions, crash recovery, and controlled browser actions.',
      keywords: ['browser automation', 'crash recovery']
    });

    const request = fetchMock.mock.calls[0][1];
    expect(request.headers.Authorization).toBe('Bearer saved-ui-key');
    const requestBody = JSON.parse(request.body);
    expect(requestBody.model).toBe('z-ai/glm-5.3-flash');
    expect(requestBody.response_format.type).toBe('json_schema');
  });

  test('searches bookmark definitions and summaries with AI', async () => {
    mockChatResponse(JSON.stringify({
      matches: [{ id: 0, reason: 'It directly covers crash recovery for Electron browser tabs.' }]
    }));

    const result = await service.searchBookmarksWithAI('How did we handle tab crashes?', [
      {
        url: 'https://example.com/bookmarks',
        title: 'Bookmarks',
        bookmarkDefinition: 'A guide to bookmark searching.',
        bookmarkSummary: 'Saved page search design.',
        lastOpened: 1
      },
      {
        url: 'https://example.com/crashes',
        title: 'Crash recovery',
        bookmarkDefinition: 'Electron tab crash recovery guide.',
        bookmarkSummary: 'Explains paused tabs and native crash recovery.',
        lastOpened: 2
      }
    ]);

    expect(result.matches).toEqual([
      { id: 0, reason: 'It directly covers crash recovery for Electron browser tabs.' }
    ]);
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(requestBody.messages[1].content).toContain('How did we handle tab crashes?');
    expect(requestBody.messages[1].content).toContain('Electron tab crash recovery guide.');
  });

  test('getCleanedPageContent should return a CSS selector', async () => {
    mockChatResponse('{"mainContentSelector":"div#content"}');

    const sourceHtml = '<html><body><div id="content">Main content</div></body></html>';
    const selector = await service.getCleanedPageContent(sourceHtml);

    expect(selector).toBe('div#content');
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(requestBody.response_format.type).toBe('json_schema');
    expect(requestBody.messages[1].content).toContain(sourceHtml);
  });

  test('getCleanedPageContent should handle invalid JSON response', async () => {
    mockChatResponse('Not a valid JSON response');

    await expect(service.getCleanedPageContent('<html><body><div id="content">Main content</div></body></html>')).rejects.toThrow(
      'Failed to get main content selector from OpenRouter'
    );
  });

  test('getRelatedStoryLinks should return an array of links', async () => {
    mockChatResponse('{"links":[{"title":"Story 1","href":"/story1"}]}');

    const sourceHtml = '<html><body><div id="related"><a href="/story1">Story 1</a></div></body></html>';
    const links = await service.getRelatedStoryLinks(sourceHtml);

    expect(links).toEqual([{ title: 'Story 1', href: '/story1' }]);
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(requestBody.response_format.type).toBe('json_schema');
    expect(requestBody.messages[1].content).toContain(sourceHtml);
  });

  test('getRelatedStoryLinks should handle empty array response', async () => {
    mockChatResponse('{"links":[]}');

    const links = await service.getRelatedStoryLinks('<html><body><div>No related links</div></body></html>');

    expect(links).toEqual([]);
  });

  test('getRelatedStoryLinks should handle invalid JSON response', async () => {
    mockChatResponse('Not a valid JSON response');

    await expect(service.getRelatedStoryLinks('<html><body><div>Content</div></body></html>')).rejects.toThrow(
      'Failed to get related story links from OpenRouter'
    );
  });

  test('getAssistantNextAction should parse planner actions', async () => {
    mockChatResponse('{"type":"tool_call","tool":"list_tabs","arguments":{}}');

    const action = await service.getAssistantNextAction({
      prompt: 'Find a used bike',
      messages: [
        { role: 'user', content: 'Find a used bike' },
      ],
      browserState: { activeTab: { tabId: 'tab-1' } },
      taskProfile: { kind: 'shopping' },
    });

    expect(action).toEqual({
      type: 'tool_call',
      tool: 'list_tabs',
      arguments: {},
    });

    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(requestBody.response_format.type).toBe('json_schema');
    expect(requestBody.structured_outputs).toBe(true);
  });

  test('getAssistantNextAction should parse clarification actions', async () => {
    mockChatResponse('{"type":"clarify","question":"What budget should I use?","reason":"The request is missing a budget.","missingInfo":["budget"]}');

    const action = await service.getAssistantNextAction({
      prompt: 'I need a used bike',
      messages: [
        { role: 'user', content: 'I need a used bike' },
      ],
      browserState: { activeTab: { tabId: 'tab-1' } },
      taskProfile: { kind: 'shopping' },
    });

    expect(action).toEqual({
      type: 'clarify',
      question: 'What budget should I use?',
      reason: 'The request is missing a budget.',
      missingInfo: ['budget'],
    });
  });

  test('should handle API errors gracefully', async () => {
    mockChatResponse('{"error":{"message":"API Error"}}', { ok: false, status: 401 });

    await expect(service.getGeminiSummary('This is some sample content')).rejects.toThrow(
      'OpenRouter summary request failed'
    );
  });

  test('should throw error if API key is not configured', async () => {
    delete process.env.OPENROUTER_API_KEY;

    await expect(service.getGeminiSummary('test')).rejects.toThrow(
      'OpenRouter API key not configured'
    );
  });
});
