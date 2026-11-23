// Real local HTTP protocol smoke test; live lookup is opt-in and may incur costs.
const BASE = process.env.SMOKE_BASE_URL || 'http://localhost:3900';

let idCounter = 1;
async function rpc(method, params) {
  const body = { jsonrpc: '2.0', id: idCounter++, method, params };
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${process.env.JOBSTACK_MCP_CLIENT_TOKEN || ''}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  // StreamableHTTPServerTransport may respond with either a JSON body or an
  // SSE stream ("event: message\ndata: {...}\n\n") depending on client Accept
  // headers / SDK version. Handle both.
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('text/event-stream') || text.includes('\ndata:') || text.startsWith('data:')) {
    const dataLine = text.split('\n').find((l) => l.startsWith('data:'));
    if (!dataLine) throw new Error(`no SSE data line in response: ${text}`);
    return { status: res.status, json: JSON.parse(dataLine.slice(5).trim()) };
  }
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function main() {
  console.log(`Smoke-testing jobstack-mcp at ${BASE} ...\n`);

  // 1. health
  const health = await fetch(`${BASE}/health`).then((r) => r.json());
  console.log('== GET /health ==');
  console.log(JSON.stringify(health, null, 2));
  if (!health.ok) throw new Error('health check failed');

  // 2. initialize
  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'jobstack-mcp-smoke-test', version: '1.0.0' },
  });
  console.log('\n== initialize ==');
  console.log(`HTTP ${init.status}`);
  console.log(JSON.stringify(init.json, null, 2));
  if (init.status !== 200 || init.json?.error) throw new Error('initialize failed');
  const serverName = init.json?.result?.serverInfo?.name;
  if (serverName !== 'jobstack') throw new Error(`unexpected server name: ${serverName}`);

  // 3. tools/list
  const list = await rpc('tools/list', {});
  console.log('\n== tools/list ==');
  const tools = list.json?.result?.tools || [];
  console.log(`HTTP ${list.status}, ${tools.length} tools:`);
  for (const t of tools) {
    console.log(`  - ${t.name}: ${t.description.slice(0, 90)}${t.description.length > 90 ? '...' : ''}`);
  }
  if (tools.length !== 2) throw new Error(`expected exactly 2 tools, got ${tools.length}`);
  const searchTool = tools.find((t) => t.name === 'search_jobs');
  if (!searchTool) throw new Error('search_jobs tool missing');
  if (!tools.find((t) => t.name === 'get_job')) throw new Error('get_job tool missing');
  console.log('\nsearch_jobs inputSchema:');
  console.log(JSON.stringify(searchTool.inputSchema, null, 2));

  if (process.env.SMOKE_ALLOW_REAL_LOOKUP !== '1') {
    console.log('Skipping live lookup; set SMOKE_ALLOW_REAL_LOOKUP=1 only for an authorized workload.');
    return;
  }

  // 4. tools/call search_jobs with a real query against the keyless themuse
  //    source (no upstream key needed), though the origin still fronts /v1/*
  //    with the RapidAPI proxy-secret guard.
  const call = await rpc('tools/call', {
    name: 'search_jobs',
    arguments: { keywords: 'engineer', sources: 'themuse', limit: 3 },
  });
  console.log('\n== tools/call search_jobs {keywords:"engineer", sources:"themuse", limit:3} ==');
  console.log(`HTTP ${call.status}`);
  const resultText = call.json?.result?.content?.[0]?.text;
  console.log(resultText);
  if (call.json?.result?.isError) {
    const guarded = !process.env.JOBSTACK_MCP_PROXY_SECRET &&
      /403|RapidAPI|proxy|forbidden/i.test(resultText || '');
    if (guarded) {
      console.log('\n[warn] tools/call hit the upstream RapidAPI proxy-secret guard and no JOBSTACK_MCP_PROXY_SECRET is set locally — expected. Protocol surface verified; set the secret to exercise a real end-to-end fetch.');
    } else {
      throw new Error(`tools/call returned isError: ${resultText}`);
    }
  } else {
    const parsed = resultText ? JSON.parse(resultText) : null;
    if (!parsed || !Array.isArray(parsed.results)) throw new Error('search_jobs returned an unexpected shape');
  }

  console.log('\nAll smoke tests passed.');
}

main().catch((err) => {
  console.error('\nSMOKE TEST FAILED:', err);
  process.exit(1);
});
