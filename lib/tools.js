// lib/tools.js — MCP tool definitions for the JobStack connector.
//
// One tool per JobStack API endpoint (see src/routes.js in the jobs-api repo for
// the source of truth). Every tool is a thin, stateless fetch against the live
// JobStack deployment — no caching, no per-caller auth, no per-caller state.
// JobStack's data (job postings fused from USAJOBS, Adzuna, Jooble, The Muse,
// Reed, and five ATS boards into one flat Job shape) is fully public, so there is
// nothing to gate on the MCP-caller side: every caller sends the same request
// shape and gets the same real data back.
//
// The upstream jobs-api deployment IS metered (sold on RapidAPI/Apify) and its
// /v1/* routes sit behind a RapidAPI proxy-secret guard, so this connector
// authenticates its own outbound calls with that same proxy secret
// (JOBSTACK_MCP_PROXY_SECRET, sent as the X-RapidAPI-Proxy-Secret header) and
// applies its own soft per-IP rate limit (api/mcp.js + lib/ratelimit.js) so this
// free MCP tier stays a discovery/growth channel rather than an unmetered bypass
// of the paid listing.
//
// Base URL is configurable via JOBSTACK_MCP_API_BASE_URL for local/self-hosted
// testing; it defaults to the production deployment.

import { z } from 'zod';

const BASE_URL = (process.env.JOBSTACK_MCP_API_BASE_URL || 'https://jobs-api-gamma.vercel.app').replace(/\/+$/, '');
// The production JobStack deployment gates /v1/* behind a RapidAPI-proxy-secret
// (see jobs-api/src/guard.js — only /api/health is open on the origin). This
// connector authenticates as that same RapidAPI-proxy consumer class to reach
// real data by sending the secret in the X-RapidAPI-Proxy-Secret header — see
// lib/ratelimit.js for the usage cap that keeps this a free/discovery tier rather
// than an unmetered bypass of the paid RapidAPI/Apify listing.
const PROXY_SECRET = process.env.JOBSTACK_MCP_PROXY_SECRET || '';

const asText = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const asError = (err) => ({
  isError: true,
  content: [{ type: 'text', text: `Error: ${err.message || String(err)}` }],
});

// Every JobStack tool only reads public job-posting data — never writes, never
// touches a caller's account (there is no account). openWorldHint is true because
// the underlying data comes from live job boards / ATS feeds (an open, changing
// world outside this server's control).
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

function buildUrl(path, params = {}) {
  const url = new URL(BASE_URL + path);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url;
}

async function callUpstream(path, params) {
  const url = buildUrl(path, params);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  let res;
  try {
    const headers = { accept: 'application/json' };
    if (PROXY_SECRET) headers['X-RapidAPI-Proxy-Secret'] = PROXY_SECRET;
    res = await fetch(url, { headers, signal: controller.signal });
  } catch (e) {
    throw new Error(`JobStack API request failed (${url.pathname}${url.search}): ${e.message || e}`);
  } finally {
    clearTimeout(timeout);
  }

  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }

  if (!res.ok) {
    const message = body?.error?.message || `JobStack API returned HTTP ${res.status} for ${url.pathname}${url.search}`;
    const err = new Error(message);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

// Wraps a (args) => { path, params } mapper into an MCP tool handler that calls
// JobStack and returns the JSON as tool-result content, or a typed error.
function forward(mapper) {
  return async (args = {}) => {
    try {
      const { path, params } = mapper(args);
      return asText(await callUpstream(path, params));
    } catch (err) {
      return asError(err);
    }
  };
}

export function registerTools(server) {
  server.registerTool(
    'search_jobs',
    {
      title: 'Search jobs (unified feed)',
      description:
        'Search job postings across every configured source and merge the results into one flat Job shape. Fans out in parallel to USAJOBS, Adzuna, Jooble, The Muse, Reed, and the ats engine (Greenhouse/Lever/Ashby/Workable/SmartRecruiters), then merges + sorts by postedDate (newest first) and paginates the combined set. Each Job has id, source, title, company, location, remote, url, description, postedDate, salaryMin, salaryMax, salaryCurrency, department, and employmentType. The response envelope carries meta, the echoed query, sources_requested, an optional sources_errored map, total, count, limit, offset, and results. Use sources= to restrict to specific engines.',
      inputSchema: {
        keywords: z.string().optional().describe('Free-text search terms (job title, skill, company, etc.). Optional — omit to browse the latest postings.'),
        location: z.string().optional().describe('Free-text location filter (e.g. "Washington, DC" or "London"). Applied upstream where the source supports it.'),
        remote: z.boolean().optional().describe('Filter to remote roles when true. Only sources that expose an explicit remote signal apply it; others ignore it.'),
        sources: z.string().optional().describe('Comma-separated engine keys to restrict the fan-out to. Any of: usajobs, adzuna, jooble, themuse, reed, ats. Omit for all six.'),
        limit: z.number().int().min(1).max(100).optional().describe('Max results in the merged page, clamped 1-100. Default 20.'),
        offset: z.number().int().min(0).optional().describe('Zero-based offset into the merged result set for pagination. Default 0.'),
      },
      annotations: RO,
    },
    forward(({ keywords, location, remote, sources, limit, offset }) => ({
      path: '/v1/jobs/search',
      params: { keywords, location, remote, sources, limit, offset },
    }))
  );

  server.registerTool(
    'get_job',
    {
      title: 'Get a single job by source + id',
      description:
        'Fetch one job posting by its source engine and native id, returned as { meta, job } with the same flat Job shape search_jobs yields. The id is the native upstream id as returned by that source in search results (NOT prefixed with the source name). Exception: for source="ats" the id is a composite "board:company:nativeId" string (e.g. "greenhouse:airbnb:7995153") so the lookup can round-trip to the right ATS board. Not every source supports single-job lookup — a search-only source returns a not_supported / not_found error.',
      inputSchema: {
        source: z.enum(['usajobs', 'adzuna', 'jooble', 'themuse', 'reed', 'ats']).describe('The engine that produced the job (matches the Job.source field from search_jobs).'),
        id: z.string().describe('Native upstream job id as returned by that source. For source="ats", the composite "board:company:nativeId" string.'),
      },
      annotations: RO,
    },
    forward(({ source, id }) => ({
      path: `/v1/jobs/${encodeURIComponent(source)}/${encodeURIComponent(id)}`,
      params: {},
    }))
  );
}

export const BASE_URL_FOR_HEALTH = BASE_URL;
