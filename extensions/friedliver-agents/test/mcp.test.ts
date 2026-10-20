import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { OMIT_ENV, PROTOCOL_VERSIONS, TOOLS, handle, omittedTools, toolsFor } from '../src/bridge/mcp';
import { BRIDGE_LIMITS, TOKEN_ENV, BRIDGE_ENV } from '../src/bridge/protocol';
import { AGENT_KEYS } from '../src/shared/model';
import { SYSTEM_TOOLS, type SystemTool } from '../src/shared/system';
import { buildBridge } from './helpers';

const request = (id: number, method: string, params?: object) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });

describe('the FriedLiver tools server (MCP)', () => {
  it('agrees on a protocol version and describes itself', () => {
    expect(handle(request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} }))).toEqual({
      reply: {
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'friedliver', version: '1.0.0' },
          instructions: expect.stringMatching(/Tools from FriedLiver[\s\S]*index_search[\s\S]*index_outline[\s\S]*index_read[\s\S]*index_diff/),
        },
      },
    });
    const newest = handle(request(2, 'initialize', { protocolVersion: '1999-01-01' }));
    expect(newest && 'reply' in newest && (newest.reply as { result: { protocolVersion: string } }).result.protocolVersion).toBe(PROTOCOL_VERSIONS[0]);
    expect(handle(request(3, 'ping'))).toEqual({ reply: { jsonrpc: '2.0', id: 3, result: {} } });
    expect(handle(request(4, 'resources/list'))).toEqual({ reply: { jsonrpc: '2.0', id: 4, error: { code: -32601, message: 'Method not found' } } });
  });

  it('lists the tools with schemas that match what the editor accepts', () => {
    const listed = handle(request(5, 'tools/list'));
    expect(listed && 'reply' in listed && (listed.reply as { result: { tools: unknown } }).result.tools).toBe(TOOLS);
    expect(TOOLS.map((t) => t.name)).toEqual(['list_agents', 'list_chats', 'ask_agent', 'send_to_chat', 'read_chat', 'remember', 'index_search', 'index_symbols', 'index_read', 'index_outline', 'index_related', 'index_diff', 'index_changes', 'browser_open', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_screenshot', 'browser_console', 'browser_back', 'browser_reload', ...SYSTEM_TOOLS]);
    const ask = TOOLS[2].inputSchema as unknown as { properties: Record<string, { enum?: string[]; maxLength?: number }>; required: string[] };
    expect(ask.properties.agent.enum).toEqual(AGENT_KEYS.filter((a) => a !== 'demo'));
    expect(ask.properties.prompt.maxLength).toBe(BRIDGE_LIMITS.text);
    expect(ask.required).toEqual(['agent', 'prompt']);
    expect((TOOLS[4].inputSchema as unknown as { properties: { last: { maximum: number } } }).properties.last.maximum).toBe(BRIDGE_LIMITS.last);
    for (const t of TOOLS) expect(t.execution).toEqual({ taskSupport: 'forbidden' });
  });

  it('passes good calls on with their progress token, and answers bad ones itself', () => {
    expect(handle(request(6, 'tools/call', { name: 'ask_agent', arguments: { agent: 'demo', prompt: 'hi' }, _meta: { progressToken: 'p1' } }))).toEqual({
      call: 'ask_agent',
      args: { agent: 'demo', prompt: 'hi' },
      id: 6,
      progressToken: 'p1',
    });
    expect(handle(request(7, 'tools/call', { name: 'list_chats' }))).toEqual({ call: 'list_chats', args: {}, id: 7 });
    for (const [name, args] of [
      ['ask_agent', { agent: 'someone', prompt: 'hi' }],
      ['ask_agent', { agent: 'demo' }],
      ['read_chat', { chat_id: 'not a chat id!' }],
      ['read_chat', { chat_id: 'chat-1', last: 51 }],
      ['send_to_chat', { chat_id: 'chat-1', message: 'x'.repeat(BRIDGE_LIMITS.text + 1) }],
      ['list_agents', 'not an object'],
    ] as const) {
      const out = handle(request(8, 'tools/call', { name, arguments: args }));
      expect(out, `${name} ${JSON.stringify(args).slice(0, 40)}`).toMatchObject({ reply: { id: 8, result: { isError: true, content: [{ type: 'text', text: expect.stringContaining('Invalid arguments') }] } } });
    }
    expect(handle(request(9, 'tools/call', { name: 'rm_rf' }))).toMatchObject({ reply: { result: { isError: true, content: [{ text: 'MCP error -32602: Tool rm_rf not found' }] } } });
  });

  it('answers no notification and no garbage', () => {
    expect(handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    expect(handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 6 } })).toBeNull();
    for (const junk of [null, 42, 'tools/list', [], { id: 1 }, { id: {}, method: 'ping' }]) expect(handle(junk)).toBeNull();
  });

  it('runs over stdio, says when the editor is gone, and exits when the agent closes it', async () => {
    const script = await buildBridge();
    const child = spawn(process.execPath, [script], { env: { ...process.env, [BRIDGE_ENV]: '/nonexistent/friedliver.sock', [TOKEN_ENV]: 'a'.repeat(64) }, stdio: ['pipe', 'pipe', 'inherit'] });
    const lines: Record<string, unknown>[] = [];
    let buffer = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      buffer += d;
      for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
        lines.push(JSON.parse(buffer.slice(0, nl)));
        buffer = buffer.slice(nl + 1);
      }
    });
    const exited = new Promise<number | null>((r) => child.once('exit', r));
    child.stdin.write(`${JSON.stringify(request(1, 'initialize', { protocolVersion: '2025-06-18' }))}\n{not json\n`);
    child.stdin.write(`${JSON.stringify([{ jsonrpc: '2.0', method: 'notifications/initialized' }, request(2, 'tools/list')])}\n`);
    child.stdin.write(`${JSON.stringify(request(3, 'tools/call', { name: 'list_agents' }))}\n`);
    const end = Date.now() + 10_000;
    while (lines.length < 3 && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    expect(lines.map((l) => l.id)).toEqual([1, 2, 3]);
    expect(lines[2]).toMatchObject({ result: { isError: true, content: [{ text: expect.stringContaining('FriedLiver closed the connection') }] } });
    child.stdin.end();
    expect(await exited).toBe(0);
  }, 20_000);
});

describe('tools/list carries only what a session can use', () => {
  const allOn = Object.fromEntries(SYSTEM_TOOLS.map((t) => [t, true])) as Record<SystemTool, boolean>;
  const names = (omit: string[]) => toolsFor(omit).map((t) => t.name);

  it('sends no $schema in any input schema', () => {
    expect(JSON.stringify(TOOLS)).not.toContain('$schema');
  });

  it('leaves out system_* where unsupported or turned off, and index_* with the index off', () => {
    expect(omittedTools({ platform: 'mac', system: { enabled: true, tools: allOn }, index: true })).toEqual([]);
    expect(omittedTools({ platform: 'win', system: { enabled: true, tools: allOn }, index: true })).toEqual(['system_shortcut']);
    expect(omittedTools({ platform: 'other', system: { enabled: true, tools: allOn }, index: true }).sort()).toEqual([...SYSTEM_TOOLS].sort());
    expect(omittedTools({ platform: 'mac', system: { enabled: false, tools: allOn }, index: true }).sort()).toEqual([...SYSTEM_TOOLS].sort());
    expect(omittedTools({ platform: 'mac', index: true }).sort()).toEqual([...SYSTEM_TOOLS].sort());
    expect(omittedTools({ platform: 'mac', system: { enabled: true, tools: { ...allOn, system_volume: false } as Record<SystemTool, boolean> }, index: true })).toEqual(['system_volume']);
    const noIndex = omittedTools({ platform: 'mac', system: { enabled: true, tools: allOn }, index: false });
    expect(noIndex.length).toBe(7);
    expect(noIndex.every((n) => n.startsWith('index_'))).toBe(true);

    const linux = omittedTools({ platform: 'other', system: { enabled: true, tools: allOn }, index: false });
    expect(names(linux).some((n) => /^(system|index)_/.test(n))).toBe(false);
    expect(names(linux)).toContain('browser_open');
    // Smaller by the schemas left out, and the same object each time (cheap to answer every session).
    expect(JSON.stringify(toolsFor(linux)).length).toBeLessThan(JSON.stringify(TOOLS).length * 0.7);
    expect(toolsFor(linux)).toBe(toolsFor([...linux].reverse()));
  });

  it('answers tools/list, tools/call and the instructions to match', () => {
    const omit = omittedTools({ platform: 'other', index: false });
    const list = handle(request(1, 'tools/list'), false, omit) as { reply: { result: { tools: { name: string }[] } } };
    expect(list.reply.result.tools.map((t) => t.name)).toEqual(names(omit));
    expect(handle(request(2, 'tools/call', { name: 'index_search', arguments: { query: 'x' } }), false, omit)).toMatchObject({ reply: { result: { isError: true, content: [{ text: expect.stringContaining('not found') }] } } });
    const init = handle(request(3, 'initialize', { protocolVersion: '2025-06-18' }), false, omit) as { reply: { result: { instructions: string } } };
    expect(init.reply.result.instructions).not.toMatch(/index_|system_/);
    expect(init.reply.result.instructions).toContain('browser_*');
  });

  it('takes the list the editor worked out over stdio', async () => {
    const script = await buildBridge();
    const child = spawn(process.execPath, [script], { env: { ...process.env, [BRIDGE_ENV]: '/nonexistent/friedliver.sock', [TOKEN_ENV]: 'a'.repeat(64), [OMIT_ENV]: 'index_search,system_open' }, stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d));
    child.stdin.write(`${JSON.stringify(request(1, 'tools/list'))}\n`);
    const end = Date.now() + 10_000;
    while (!out.includes('\n') && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    const tools = (JSON.parse(out.split('\n')[0]) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
    expect(tools).not.toContain('index_search');
    expect(tools).not.toContain('system_open');
    expect(tools).toContain('index_read');
    child.stdin.end();
  }, 20_000);
});
