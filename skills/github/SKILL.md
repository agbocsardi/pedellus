---
name: github
description: Inspect and manage GitHub issues, pull requests, and Actions runs with the gh CLI. Use when the task requires GitHub data or CI status.
metadata: {"nanobot":{"requires":{"bins":["gh"]}}}
---

# GitHub

`gh` is available only through the granted `bash` tool; this port has no GitHub
tool. Require `bash` before starting.

## Check access first

```bash
gh --version
gh auth status
```

The guarded shell uses a filtered environment: `HOME` is the workspace and host
credentials are not inherited, so `gh` is authenticated only when the user has
placed a `gh` configuration inside the workspace. Expect to stop here often. If
`gh auth status` fails, report that this conversation cannot reach the GitHub
API and let the user decide what to do. Do not place tokens or other secrets in
the workspace, paste them into the conversation, or commit them, do not write a
credential file yourself, and do not continue with `gh` commands while
unauthenticated.

## Working directory

Run commands inside the repository when it is present. Otherwise pass
`--repo owner/repo` (or a URL) explicitly.

## Pull requests and CI

```bash
gh pr checks 55 --repo owner/repo
gh run list --repo owner/repo --limit 10
gh run view <run-id> --repo owner/repo
gh run view <run-id> --repo owner/repo --log-failed
```

## Issues and API

Use `gh issue`, `gh pr`, `gh run`, and `gh api`. `gh api` reaches data that the
subcommands do not expose:

```bash
gh api repos/owner/repo/pulls/55 --jq '.title, .state, .user.login'
gh issue list --repo owner/repo --json number,title \
  --jq '.[] | "\(.number): \(.title)"'
```

Mutations (`gh pr create`, `gh issue comment`, merges, closures) are visible
external actions. Confirm the user wants them before running one, and report the
resulting URL or identifier.
