# Security policy

Security fixes are developed against the current `master` branch. This project
does not currently promise security backports to older versions.

## Reporting a vulnerability

Please avoid publishing exploit details, credentials, or private browser data
in public issues. Use GitHub's **Report a vulnerability** option in the
repository's Security tab when available. If private reporting is unavailable,
open an issue asking maintainers for a private contact channel without
including sensitive details.

In a private report, include the affected revision, reproduction steps,
expected impact, and any suggested mitigation. Redact API keys, tokens,
cookies, and personal information from logs and screenshots.

## Credentials and development

Keep credentials in local settings or ignored environment files. Use only
placeholder values in examples. If a credential is accidentally published,
revoke or rotate it immediately; removing it from a commit does not invalidate
it. Keep browser debugging and automation endpoints restricted to trusted
local access.
