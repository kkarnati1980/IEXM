#!/usr/bin/env node
/**
 * Codex Platform — Kiosk Push Server
 *
 * Runs on Pi 5 at port 8080 (or $PORT).
 * Tablet opens: http://<PI_IP>:8080
 * NFC tap → codex-tap.sh POSTs consent URL to /push
 * Tablet auto-navigates to consent screen via Server-Sent Events.
 *
 * Routes:
 *   GET  /        — tablet idle page
 *   GET  /events  — SSE stream for tablet
 *   POST /push    — receive consent URL from tap script
 *   GET  /health  — liveness check
 */

const http = require('http')
const url = require('url')

// Active SSE connections (tablet browser tabs)
const clients = new Set()

// Last push — replayed to reconnecting tablets within 30 s
let lastConsentUrl = null
let lastPushTime = null

// ── Tablet idle page ─────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
  <title>Codex Kiosk</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Segoe UI', sans-serif;
      background: #0a0e1a;
      color: #f4f1ea;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      padding: 40px;
    }
    .status {
      font-size: 14px;
      color: rgba(244,241,234,0.4);
      margin-bottom: 48px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    .icon { font-size: 80px; margin-bottom: 24px; }
    h1 { font-size: 32px; font-weight: 700; margin-bottom: 12px; }
    p { font-size: 18px; color: rgba(244,241,234,0.6); max-width: 320px; }
    .dot {
      display: inline-block;
      width: 10px; height: 10px;
      border-radius: 50%;
      background: #22c55e;
      margin-right: 8px;
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50%       { opacity: 0.3; }
    }
  </style>
</head>
<body>
  <div class="status"><span class="dot"></span>Codex Platform</div>
  <div class="icon">📱</div>
  <h1>Ready for tap</h1>
  <p>Ask the exhibitor to tap your badge on the reader</p>
  <script>
    const evtSource = new EventSource('/events')

    evtSource.onmessage = function(e) {
      const data = JSON.parse(e.data)
      if (data.type === 'consent' && data.url) {
        window.location.href = data.url
      }
    }

    // Reconnect automatically if SSE drops
    evtSource.onerror = function() {
      setTimeout(() => window.location.reload(), 2000)
    }

    console.log('[kiosk] Ready for NFC tap')
  </script>
</body>
</html>`

// ── Request handler ──────────────────────────────────────────
const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true)

  // GET / — tablet idle page
  if (req.method === 'GET' && parsed.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(HTML)
    return
  }

  // GET /events — SSE stream
  if (req.method === 'GET' && parsed.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    })

    // Initial keepalive ping
    res.write('data: {"type":"ping"}\n\n')

    // Replay last push if it arrived within the past 30 s
    if (lastConsentUrl && lastPushTime && (Date.now() - lastPushTime) < 30000) {
      res.write('data: ' + JSON.stringify({ type: 'consent', url: lastConsentUrl }) + '\n\n')
    }

    clients.add(res)
    console.log('[kiosk] Tablet connected. Total:', clients.size)

    req.on('close', () => {
      clients.delete(res)
      console.log('[kiosk] Tablet disconnected. Total:', clients.size)
    })
    return
  }

  // POST /push — receive consent URL from codex-tap.sh
  if (req.method === 'POST' && parsed.pathname === '/push') {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      try {
        const data = JSON.parse(body)
        const consentUrl = data.consent_url || data.url

        if (!consentUrl) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'consent_url required' }))
          return
        }

        lastConsentUrl = consentUrl
        lastPushTime = Date.now()

        const message = 'data: ' + JSON.stringify({ type: 'consent', url: consentUrl }) + '\n\n'

        let pushed = 0
        clients.forEach(client => {
          try {
            client.write(message)
            pushed++
          } catch {
            clients.delete(client)
          }
        })

        console.log('[kiosk] Pushed consent URL to', pushed, 'tablet(s)')
        console.log('[kiosk] URL:', consentUrl.substring(0, 80) + (consentUrl.length > 80 ? '…' : ''))

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ pushed, clients: clients.size }))
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
    })
    return
  }

  // GET /health — liveness
  if (req.method === 'GET' && parsed.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      status: 'ok',
      tablets: clients.size,
      last_push: lastPushTime ? new Date(lastPushTime).toISOString() : null
    }))
    return
  }

  res.writeHead(404)
  res.end()
})

const PORT = process.env.PORT || 8080
server.listen(PORT, '0.0.0.0', () => {
  console.log('[kiosk] Server running on port', PORT)
  console.log('[kiosk] Tablet URL: http://<PI_IP>:' + PORT)
  console.log('[kiosk] Push URL:   http://localhost:' + PORT + '/push')
  console.log('[kiosk] Health:     http://localhost:' + PORT + '/health')
})
