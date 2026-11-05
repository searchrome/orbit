module.exports = {
  // Indicates whether the coverage information should be collected while executing the test
  collectCoverage: true,
  
  // The directory where Jest should output its coverage files
  coverageDirectory: "coverage",
  
  // An array of glob patterns indicating a set of files for which coverage information should be collected
  collectCoverageFrom: [
    "**/*.{js,jsx}",
    "!**/node_modules/**",
    "!**/dist/**",
    "!**/coverage/**",
    "!jest.config.js",
  ],
  
  // The test environment that will be used for testing
  testEnvironment: "jsdom",
  
  // The glob patterns Jest uses to detect test files
  testMatch: [
    "**/__tests__/**/*.test.js"
  ],
  
  // An array of regexp pattern strings that are matched against all test paths, matched tests are skipped
  testPathIgnorePatterns: [
    "/node_modules/",
    "/dist/"
  ],

  modulePathIgnorePatterns: [
    "<rootDir>/dist/",
    "<rootDir>/.tmp/"
  ],
  
  // A map from regular expressions to paths to transformers
  transform: {
    "^.+\\.jsx?$": "babel-jest"
  },
  
  // Setup files to run before each test
  setupFilesAfterEnv: [
    "<rootDir>/jest.setup.js"
  ],
  
  // Mock files for specific modules
  moduleNameMapper: {
    "\\.(css|less|scss|sass)$": "<rootDir>/__mocks__/styleMock.js",
    "\\.(gif|ttf|eot|svg)$": "<rootDir>/__mocks__/fileMock.js"
  },
  
  // Indicates whether each individual test should be reported during the run
  verbose: true
};
