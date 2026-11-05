# Contributing to Orbit

Bug reports, documentation improvements, and pull requests are welcome.
Search existing issues before opening a new one. For substantial changes,
open an issue first to discuss the intended behavior.

## Development

Use Node.js 22.12 or later and npm:

```sh
git clone https://github.com/searchrome/orbit.git
cd orbit
npm install
npm start
```

Optional AI configuration is documented in the README and `.env.example`.
Use your own credentials; never commit API keys, browser profiles, cookies,
session recordings, or private browsing data.

## Validation and pull requests

Run tests relevant to your changes. `npm run test:unit -- --runInBand` runs
the unit suite; `npm run test:integration` runs integration tests.
End-to-end tests require a working desktop environment. Some existing tests
currently fail; include the command and results in your pull request and
distinguish existing failures from regressions introduced by your changes.

Explain the problem, the resulting behavior, and how you verified it. Include
screenshots for visual changes and regression tests for behavior changes
where useful. Keep changes focused and discuss dependency additions.

By submitting a contribution, you agree to license it under the project's
[MIT License](LICENSE). Treat other contributors respectfully.
