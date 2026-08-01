// api/mcp.js — the MCP endpoint. JobStack's data (job postings fused from official
// job-board feeds + public ATS boards) is fully public and carries no per-user
// state, so this connector deliberately has NO auth, NO sessions, NO Supabase, NO
// billing, NO demo-vs-real split: every caller gets the same real, live data.
// See README.md for the full rationale.
//
// Stateless streamable-HTTP MCP server, one instance per request (no session
// affinity needed since there is no per-session state to keep).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerTools } from '../lib/tools.js';
import { clientIp, checkAndConsume } from '../lib/ratelimit.js';

export default async function handler(req, res) {
  // Streamable-HTTP stateless servers only accept POST; GET/SSE-resume and
  // DELETE/session-teardown don't apply since there is no session state.
  if (req.method === 'GET' || req.method === 'DELETE') {
    return res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed (stateless server)' },
      id: null,
    });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed' },
      id: null,
    });
  }

  // Only tools/call actually reaches the metered upstream (initialize/tools/list
  // are free protocol handshake) — see lib/ratelimit.js for why this exists.
  if (req.body?.method === 'tools/call') {
    const { allowed, limit } = checkAndConsume(clientIp(req));
    if (!allowed) {
      return res.status(200).json({
        jsonrpc: '2.0',
        id: req.body?.id ?? null,
        result: {
          isError: true,
          content: [{
            type: 'text',
            text: `Rate limit exceeded (${limit} tool calls/hour on this free connector). For higher volume, use JobStack via RapidAPI or Apify: https://jobs-api-gamma.vercel.app`,
          }],
        },
      });
    }
  }

  const server = new McpServer({ name: 'jobstack', version: '1.0.0' });
  registerTools(server);

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close();
    server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[mcp] error:', err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  }
}
