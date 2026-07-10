// Minimal hook receiver: logs every request (method, url, headers, body) as one JSON line.
import http from 'node:http'
import fs from 'node:fs'

const OUT = new URL('./http-events.jsonl', import.meta.url).pathname
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    let parsed = null
    try { parsed = JSON.parse(body) } catch {}
    fs.appendFileSync(OUT, JSON.stringify({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: parsed ?? body,
    }) + '\n')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })
})
server.listen(7842, '127.0.0.1', () => console.log('listening on 127.0.0.1:7842'))
