# jobstack-mcp

A remote **MCP (Model Context Protocol)** connector for **JobStack** — the unified jobs-search API ([jobs-api](https://jobs-api-gamma.vercel.app)) that fuses official job-board feeds and public ATS boards (USAJOBS, Adzuna, Jooble, The Muse, Reed, and Greenhouse/Lever/Ashby/Workable/SmartRecruiters behind one `ats` engine) into one flat `Job` shape.

This source revision requires an MCP caller bearer token and disables both tools until individually enabled. It has no default upstream. Public access and remote provider calls require separate authorization for the exact workload and expense. The existing hosted deployment may run older code; this document does not establish its configuration or behavior.

## What this is

JobStack is a plain REST API. This repo is a thin adapter that exposes each endpoint as a discoverable, typed MCP **tool** so MCP clients (Claude, ChatGPT, any MCP-aware agent) can call it directly, speaking the MCP streamable-HTTP transport at a single `/mcp` endpoint. Enabled tools forward requests to the configured jobs-api and return its response. A search can fan out to multiple upstream sources; the upstream must enforce its own spending controls.

## Tools

| Tool | JobStack endpoint | Description |
|---|---|---|
| `search_jobs` | `GET /v1/jobs/search` | Search + merge job postings across all (or a `sources=` subset of) engines, sorted newest-first, paginated. |
| `get_job` | `GET /v1/jobs/{source}/{id}` | Fetch one job by its source engine + native id (composite `board:company:nativeId` for `ats`). |

Both tools are read-only and annotated `{ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }`.

### `search_jobs` inputs

- `keywords` (string, optional) — free-text search terms.
- `location` (string, optional) — free-text location filter.
- `remote` (boolean, optional) — filter to remote roles where the source signals it.
- `sources` (string, optional) — comma list of engine keys: `usajobs, adzuna, jooble, themuse, reed, ats`. Omit for all six.
- `limit` (int 1-100, optional, default 20).
- `offset` (int ≥0, optional, default 0).

### `get_job` inputs

- `source` (enum: `usajobs | adzuna | jooble | themuse | reed | ats`).
- `id` (string) — native upstream id from a search result; for `ats`, the composite `board:company:nativeId` string.

## Config

- `JOBSTACK_MCP_CLIENT_TOKEN`: a separately generated bearer token of at least 32 UTF-8 bytes; absent or short values disable MCP access.
- `JOBSTACK_MCP_ALLOWED_TOOLS`: comma-separated explicit tool names; empty by default.
- `JOBSTACK_MCP_API_BASE_URL`: explicit upstream origin; unset by default. Loopback origins are accepted; remote origins require HTTPS and `JOBSTACK_MCP_ALLOW_REMOTE_UPSTREAM=1`. Redirects are rejected.
- `JOBSTACK_MCP_PROXY_SECRET`: existing upstream RapidAPI credential, separate from the MCP client token.
- `JOBSTACK_MCP_RATE_LIMIT`: best-effort per-instance limit, default 30 per IP per hour; this is not a hard spending cap.
- `JOBSTACK_MCP_LISTEN_HOST`: local development bind host, default `127.0.0.1`.

Configuration flags do not themselves authorize a cloud workload or expense, and a loopback API can still call metered providers. Existing clients must be migrated to the new token and explicitly enabled tools before this revision can replace a public endpoint.

## Local development and verification

Run `npm run dev` on owned hardware. `npm run smoke` tests the protocol and health using the configured caller token, and skips live lookups unless `SMOKE_ALLOW_REAL_LOOKUP=1` is explicitly set for an authorized workload. `JOBS_API_ROOT=/path/to/jobs-api npm run check:local` runs the local connector against the real local API with outbound networking denied by macOS sandbox. This verifies fail-closed behavior, not successful external searches.

Do not push until all automatic build triggers are verified disabled. Deployment requires separate authorization for the exact hosted workload and expense.
