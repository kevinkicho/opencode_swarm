#!/usr/bin/env npx tsx
// @ts-nocheck
//
// Probe all three AI pipelines for tool-call reliability.
// Tests whether each provider/model combo invokes todowrite or produces prose-only.
//
// Run: npx tsx scripts/probe-pipelines.ts

const OCODE = process.env.OPENCODE_URL || 'http://172.24.32.1:4096';
const DIR = 'C:\\Users\\kevin\\Desktop\\opencode_swarm';
const USER = process.env.OPENCODE_BASIC_USER || 'opencode';
const PASS = process.env.OPENCODE_BASIC_PASS || '';  // from .env

const PROBES = [
  { label: 'ollama-cloud (GLM)', provider: 'ollama', model: 'glm-5.1:cloud', agent: 'plan' },
  { label: 'go (GLM)', provider: 'opencode-go', model: 'glm-5.1', agent: 'plan' },
  { label: 'zen (GLM)', provider: 'opencode', model: 'glm-5.1', agent: 'plan' },
  { label: 'ollama (GEMMA)', provider: 'ollama', model: 'gemma4:31b-cloud', agent: 'build' },
  { label: 'ollama (NEMOTRON)', provider: 'ollama', model: 'nemotron-3-super:cloud', agent: 'build' },
  { label: 'ollama (no agent)', provider: 'ollama', model: 'glm-5.1:cloud', agent: undefined },
];

async function probe(provider, model, agent, label) {
  const auth = Buffer.from(`${USER}:${PASS}`).toString('base64');
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Basic ${auth}`,
  };

  // 1. Create session
  const createRes = await fetch(`${OCODE}/session?directory=${encodeURIComponent(DIR)}`, {
    method: 'POST', headers, body: '{}',
  });
  const session = await createRes.json();
  const sid = session.id;
  console.log(`\n### ${label}`);
  console.log(`  Session: ${sid.slice(-8)}`);

  // 2. Post prompt asking for todowrite
  const body = {
    parts: [{ type: 'text', text: 'Use the todowrite tool to create exactly ONE todo with content: "Probe test — verify tool calling works for pipeline ' + label + '"' }],
    agent: agent,
    model: { providerID: provider, modelID: model },
  };

  const postRes = await fetch(`${OCODE}/session/${sid}/prompt_async?directory=${encodeURIComponent(DIR)}`, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  console.log(`  Prompt posted: HTTP ${postRes.status}`);

  // 3. Wait for response
  let toolCount = 0;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const msgRes = await fetch(`${OCODE}/session/${sid}/message?directory=${encodeURIComponent(DIR)}`, { headers });
    const msgs = await msgRes.json();
    const assistant = msgs.filter(m => m.info.role === 'assistant' && m.info.time.completed);

    for (const m of assistant) {
      const tools = (m.parts || []).filter(p => p.type === 'tool');
      toolCount += tools.length;
      for (const t of tools) {
        console.log(`  ✅ TOOL CALL: ${t.tool} — status=${t.state?.status || '?'}`);
      }
      const texts = (m.parts || []).filter(p => p.type === 'text');
      if (texts.length > 0) {
        console.log(`  📝 TEXT: ${(texts[0].text || '').slice(0, 80)}`);
      }
      if (m.info.error) {
        console.log(`  ❌ ERROR: ${m.info.error}`);
      }
    }

    if (toolCount > 0) break;
    if (assistant.length > 0 && toolCount === 0) {
      console.log(`  ⚠️ Assistant completed but NO tool calls — prose only`);
      break;
    }
  }

  if (toolCount === 0) {
    console.log(`  ❌ FAILED: No todowrite call after 150s`);
  }

  return { label, toolCount, sid };
}

async function main() {
  console.log('# Pipeline Probe — tool-call reliability\n');
  console.log('Testing all 3 provider pipelines + no-agent control.\n');

  const results = [];
  for (const p of PROBES) {
    const r = await probe(p.provider, p.model, p.agent, p.label);
    results.push(r);
  }

  console.log('\n---\n## Results\n');
  console.log('| Pipeline | Tool calls | Verdict |');
  console.log('|----------|-----------|---------|');
  for (const r of results) {
    const verdict = r.toolCount > 0 ? '✅ WORKS' : '❌ BROKEN (prose-only)';
    console.log(`| ${r.label} | ${r.toolCount} | ${verdict} |`);
  }

  const broken = results.filter(r => r.toolCount === 0);
  if (broken.length > 0) {
    console.log('\n⚠️ Broken pipelines:');
    for (const b of broken) {
      console.log(`  - ${b.label}: session ${b.sid} — model accepted prompt but did not invoke todowrite`);
    }
  }
}

main().catch(e => console.error(e.message));
