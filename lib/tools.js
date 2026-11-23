import { z } from 'zod';
import { upstreamConfig } from './config.js';

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
  const config = upstreamConfig();
  if (!config.ok) throw new Error(`JobStack upstream unavailable (${config.reason}).`);
  const url = new URL(config.baseUrl + path);
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
  let text;
  try {
    const headers = { accept: 'application/json' };
    if (PROXY_SECRET) headers['X-RapidAPI-Proxy-Secret'] = PROXY_SECRET;
    res = await fetch(url, { headers, signal: controller.signal, redirect: 'error' });
    text = await res.text();
  } catch (e) {
    throw new Error(`JobStack API request failed (${url.pathname}${url.search}): ${e.message || e}`);
  } finally {
    clearTimeout(timeout);
  }

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
function forward(tool, mapper) {
  return async (args = {}) => {
    try {
      const allowed = new Set((process.env.JOBSTACK_MCP_ALLOWED_TOOLS || '').split(',').map(s => s.trim()).filter(Boolean));
      if (!allowed.has(tool)) throw new Error(`JobStack tool ${tool} is disabled by the operator.`);
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
    forward('search_jobs', ({ keywords, location, remote, sources, limit, offset }) => ({
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
    forward('get_job', ({ source, id }) => ({
      path: `/v1/jobs/${encodeURIComponent(source)}/${encodeURIComponent(id)}`,
      params: {},
    }))
  );
}

export const upstreamStatus = () => upstreamConfig();
