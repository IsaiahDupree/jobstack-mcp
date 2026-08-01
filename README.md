# jobstack-mcp

A remote **MCP (Model Context Protocol)** connector for **JobStack** — the unified jobs-search API ([jobs-api](https://jobs-api-gamma.vercel.app)) that fuses official job-board feeds and public ATS boards (USAJOBS, Adzuna, Jooble, The Muse, Reed, and Greenhouse/Lever/Ashby/Workable/SmartRecruiters behind one `ats` engine) into one flat `Job` shape.

**Live:** `https://jobstack-mcp.vercel.app/mcp` — 2 tools, exposed over the MCP streamable-HTTP transport. Since the upstream jobs-api deployment is metered (RapidAPI/Apify) and its `/v1/*` routes sit behind a RapidAPI proxy-secret guard, this connector authenticates its own outbound calls with that same secret (`JOBSTACK_MCP_PROXY_SECRET`, sent as the `X-RapidAPI-Proxy-Secret` header) and applies a soft per-IP rate limit (`JOBSTACK_MCP_RATE_LIMIT`, default 30 tool-calls/hour, in-memory) so the free MCP tier stays a discovery channel rather than an unmetered bypass of the paid listing — see `lib/ratelimit.js`.

## What this is

JobStack is a plain REST API. This repo is a thin adapter that exposes each endpoint as a discoverable, typed MCP **tool** so MCP clients (Claude, ChatGPT, any MCP-aware agent) can call it directly, speaking the MCP streamable-HTTP transport at a single `/mcp` endpoint. It has no business logic of its own — every tool call is a pass-through `fetch` to jobs-api, and the JSON response is handed back verbatim as the tool result.

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

- `JOBSTACK_MCP_API_BASE_URL` — upstream base URL. Default `https://jobs-api-gamma.vercel.app`.
- `JOBSTACK_MCP_PROXY_SECRET` — the RapidAPI proxy secret forwarded as `X-RapidAPI-Proxy-Secret` on outbound calls (needed for the production origin, which guards `/v1/*`).
- `JOBSTACK_MCP_RATE_LIMIT` — soft per-IP tools/call cap per hour. Default 30.

## Local development

```bash
npm install
npm run dev          # starts local-server.js on http://localhost:3900
npm run smoke        # in another terminal — real HTTP/JSON-RPC smoke test
```

`test/smoke.mjs` drives the running server over real HTTP/JSON-RPC and verifies `GET /health`, `initialize` (`serverInfo.name === "jobstack"`), and `tools/list` (the 2 tools with their zod-derived schemas), then attempts a live `search_jobs` tools/call. Without `JOBSTACK_MCP_PROXY_SECRET` set locally the upstream origin returns 403 (its RapidAPI guard) — an expected upstream-auth condition the smoke test reports as a soft warning while still verifying the full protocol surface.

## Deploy

```bash
cd /Users/isaiahdupree/Software/jobstack-mcp
npx vercel --yes --prod
```

After deploy, the MCP connector URL to register in Claude/ChatGPT/any MCP client is `https://<deployment-domain>/mcp`.
