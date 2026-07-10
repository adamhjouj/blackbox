// Minimal dependency-free MCP stdio server exposing one "echo" tool.
// MCP stdio transport = newline-delimited JSON-RPC 2.0.
import readline from 'node:readline'

const rl = readline.createInterface({ input: process.stdin })
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')

rl.on('line', (line) => {
  line = line.trim()
  if (!line) return
  let req
  try { req = JSON.parse(line) } catch { return }
  const { id, method, params } = req
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'hooktest-echo', version: '0.0.1' },
      },
    })
  } else if (method === 'tools/list') {
    send({
      jsonrpc: '2.0', id,
      result: {
        tools: [{
          name: 'echo',
          description: 'Echo back the provided message',
          inputSchema: {
            type: 'object',
            properties: { message: { type: 'string', description: 'text to echo' } },
            required: ['message'],
          },
        }],
      },
    })
  } else if (method === 'tools/call') {
    const msg = params?.arguments?.message ?? ''
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `echo: ${msg}` }] } })
  } else if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} })
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } })
  }
})
