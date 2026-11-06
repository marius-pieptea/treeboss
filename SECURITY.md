# Security

Report vulnerabilities privately through GitHub's "Report a vulnerability" (Security tab) rather than a public issue.

Scope notes: the daemon binds to `127.0.0.1` with a bearer token, and phone access is off by default. Engines run in their no-prompt modes and are **not sandboxed**; isolation comes from git worktrees. See "Safety model" in the README.
