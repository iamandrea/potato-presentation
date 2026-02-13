const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 3000;
const votes = {};
const voters = new Set();
let sseClients = [];
let resetToken = Date.now().toString();
let ngrokUrl = null;

const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.json': 'application/json',
};

function broadcast() {
  const data = JSON.stringify({ votes, totalVoters: voters.size, resetToken });
  sseClients = sseClients.filter(res => {
    try { res.write(`data: ${data}\n\n`); return true; }
    catch { return false; }
  });
}

const server = http.createServer((req, res) => {
  // API: submit vote
  if (req.method === 'POST' && req.url === '/api/vote') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { choice, voterId } = JSON.parse(body);
        if (!choice) throw new Error('No choice');
        if (voters.has(voterId)) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Already voted' }));
          return;
        }
        voters.add(voterId);
        votes[choice] = (votes[choice] || 0) + 1;
        broadcast();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, resetToken }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bad request' }));
      }
    });
    return;
  }

  // API: SSE stream for live results
  if (req.url === '/api/results') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(`data: ${JSON.stringify({ votes, totalVoters: voters.size, resetToken })}\n\n`);
    sseClients.push(res);
    req.on('close', () => {
      sseClients = sseClients.filter(c => c !== res);
    });
    return;
  }

  // API: check reset token (so vote page knows if votes were cleared)
  if (req.url === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ resetToken }));
    return;
  }

  // API: reset votes
  if (req.method === 'POST' && req.url === '/api/reset') {
    Object.keys(votes).forEach(k => delete votes[k]);
    voters.clear();
    resetToken = Date.now().toString();
    broadcast();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, resetToken }));
    return;
  }

  // API: vote URL (for QR code) — prefer ngrok if available
  if (req.url === '/api/vote-url') {
    const base = ngrokUrl || `http://${getLocalIP()}:${PORT}`;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ url: `${base}/vote.html` }));
    return;
  }

  // Static files
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(__dirname, decodeURIComponent(filePath));
  const ext = path.extname(filePath).toLowerCase();

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

// Try to detect ngrok tunnel
function detectNgrok() {
  const req = http.get('http://127.0.0.1:4040/api/tunnels', (res) => {
    let body = '';
    res.on('data', c => body += c);
    res.on('end', () => {
      try {
        const tunnels = JSON.parse(body).tunnels;
        const https = tunnels.find(t => t.proto === 'https');
        if (https) {
          ngrokUrl = https.public_url;
          console.log(`  ngrok detected: ${ngrokUrl}`);
          console.log(`  Voting page:    ${ngrokUrl}/vote.html\n`);
        }
      } catch {}
    });
  });
  req.on('error', () => {}); // ngrok not running, that's fine
}

server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log(`\n  🥔 Potato Presentation Server\n`);
  console.log(`  Presentation:  http://localhost:${PORT}`);
  console.log(`  Voting page:   http://${ip}:${PORT}/vote.html`);
  console.log(`\n  Checking for ngrok tunnel...`);
  // Check for ngrok every 3 seconds (in case it starts after the server)
  detectNgrok();
  setInterval(detectNgrok, 3000);
});
