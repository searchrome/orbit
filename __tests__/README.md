# Testing Documentation for Electron Browser

This directory contains tests for the Electron Browser application. The tests are organized into three categories:

1. **Unit Tests** - Test individual components in isolation
2. **Integration Tests** - Test how components work together
3. **End-to-End Tests** - Test complete user workflows

## Test Structure

```
__tests__/
├── unit/               # Unit tests
│   ├── tab-manager.test.js
│   └── summarizer.test.js
├── integration/        # Integration tests
│   └── network-control.test.js
├── e2e/                # End-to-end tests
│   └── browser-navigation.test.js
└── README.md           # This file
```

## Running Tests

The following npm scripts are available for running tests:

- `npm test` - Run all tests
- `npm run test:unit` - Run only unit tests
- `npm run test:integration` - Run only integration tests
- `npm run test:e2e` - Run only end-to-end tests
- `npm run test:all` - Run all tests in sequence
- `npm run test:mocha` - Run tests using electron-mocha (alternative test runner)

## Test Coverage

### Unit Tests

- **TabManager** - Tests tab creation, switching, closing, and other tab management functionality
- **Summarizer** - Tests the summarization feature, including handling of page content and display of results

### Integration Tests

- **Network Control** - Tests the interaction between main and renderer processes for network blocking functionality, cache control, and request handling

### End-to-End Tests

- **Browser Navigation** - Tests basic browser functionality like navigating to URLs, creating tabs, switching between tabs, and using browser controls

## Mocks

The tests use various mocks to simulate the Electron environment:

- `jest.setup.js` - Contains global mocks for Electron modules, DOM elements, and other dependencies
- `__mocks__/styleMock.js` - Mock for CSS imports
- `__mocks__/fileMock.js` - Mock for file imports (images, fonts, etc.)

## Adding New Tests

When adding new tests, follow these guidelines:

1. Place the test in the appropriate directory based on its type (unit, integration, or e2e)
2. Name the test file with a `.test.js` suffix
3. Use descriptive test names that clearly indicate what is being tested
4. Follow the existing patterns for setting up mocks and assertions

### Example Test Structure

```javascript
describe('Component Name', () => {
  // Set up before each test
  beforeEach(() => {
    // Set up mocks, DOM elements, etc.
  });

  // Clean up after each test
  afterEach(() => {
    // Clean up mocks, DOM elements, etc.
  });

  // Individual test cases
  test('should do something specific', () => {
    // Arrange - Set up test data
    // Act - Perform the action being tested
    // Assert - Check the results
  });
});
```

## Troubleshooting

### Common Issues

- **Spectron Connection Issues**: If end-to-end tests fail with connection issues, try increasing the `startTimeout` and `waitTimeout` values in the test setup.
- **DOM Element Not Found**: Ensure that the DOM elements you're testing exist in the test environment. You may need to add them to the `document.body.innerHTML` in the test setup.
- **Electron Module Not Found**: Make sure the Electron modules are properly mocked in `jest.setup.js`.

### Debugging Tests

To debug tests, you can use the following techniques:

1. Add `console.log` statements to your tests (these will appear in the test output)
2. Run a single test with `npm test -- -t "test name"` to focus on a specific test
3. Use the `--verbose` flag to see more detailed output: `npm test -- --verbose`
