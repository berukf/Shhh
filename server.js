const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');
const crypto   = require('crypto');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling'],
});

app.use(express.json());

// CONFIG — set ADMIN_PASSWORD in Railway environment variables
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const ADMIN_TOKEN    = crypto
  .createHash('sha256')
  .update(ADMIN_PASSWORD + '_sss_salt')
  .digest('hex');

// STATE
const waitingQueue = [];
const pairs        = new Map();   // socketId → partnerId
const userMeta     = new Map();   // socketId → { name, gender, age, ip }
const chatLogs     = new Map();   // chatId   → [{ from, text, ts }]
const pairToChat   = new Map();   // socketId → chatId
const reportsList  = [];          // all reports ever
const activeIPs    = new Map();   // ip → Set<socketId>

function getIP(socket) {
  return (
    socket.handshake.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    socket.handshake.address || 'unknown'
  );
}

function onlineCount()  { return io.engine.clientsCount; }
function uniqueIPCount(){ return activeIPs.size; }

function broadcastOnline() {
  const n = onlineCount();
  io.emit('online_count', n);
  notifyAdmins('stats', buildStats());
}

function buildStats() {
  return {
    online:             onlineCount(),
    uniqueIPs:          uniqueIPCount(),
    waiting:            waitingQueue.length,
    activePairs:        Math.floor(pairs.size / 2),
    totalReports:       reportsList.length,
    unresolvedReports:  reportsList.filter(r => !r.resolved).length,
  };
}

function notifyAdmins(event, data) {
  io.to('admins').emit(event, data);
}

function removeFromQueue(socketId) {
  const idx = waitingQueue.findIndex(u => u.socketId === socketId);
  if (idx !== -1) waitingQueue.splice(idx, 1);
}

function makeChatId() {
  return 'chat_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
}

function logMessage(socketId, text) {
  const chatId = pairToChat.get(socketId);
  if (!chatId) return;
  if (!chatLogs.has(chatId)) chatLogs.set(chatId, []);
  const meta = userMeta.get(socketId) || {};
  chatLogs.get(chatId).push({ from: meta.name || '?', text, ts: new Date().toISOString() });
}

function tryMatch(socket) {
  const idx = waitingQueue.findIndex(u => u.socketId !== socket.id);
  if (idx === -1) {
    if (!waitingQueue.find(u => u.socketId === socket.id)) {
      const meta = userMeta.get(socket.id) || {};
      waitingQueue.push({ socketId: socket.id, ...meta });
    }
    socket.emit('waiting');
    broadcastOnline();
    return;
  }

  const partner = waitingQueue.splice(idx, 1)[0];
  removeFromQueue(socket.id);

  pairs.set(socket.id, partner.socketId);
  pairs.set(partner.socketId, socket.id);

  const chatId = makeChatId();
  pairToChat.set(socket.id, chatId);
  pairToChat.set(partner.socketId, chatId);
  chatLogs.set(chatId, []);

  const myMeta      = userMeta.get(socket.id)       || {};
  const partnerMeta = userMeta.get(partner.socketId) || {};

  socket.emit('matched',                  { strangerName: partnerMeta.name || 'სტრეინჯერი' });
  io.to(partner.socketId).emit('matched', { strangerName: myMeta.name      || 'სტრეინჯერი' });

  broadcastOnline();
}

function disconnectPair(socketId) {
  const partnerId = pairs.get(socketId);
  pairs.delete(socketId);
  pairToChat.delete(socketId);
  if (partnerId) {
    pairs.delete(partnerId);
    pairToChat.delete(partnerId);
    io.to(partnerId).emit('stranger_left');
  }
}

// ADMIN AUTH
function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token === ADMIN_TOKEN) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ADMIN API
app.post('/api/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) res.json({ token: ADMIN_TOKEN });
  else res.status(401).json({ error: 'Wrong password' });
});

app.get('/api/admin/stats',   adminAuth, (req, res) => res.json(buildStats()));
app.get('/api/admin/reports', adminAuth, (req, res) => res.json(reportsList.slice().reverse()));

app.post('/api/admin/reports/:id/resolve', adminAuth, (req, res) => {
  const r = reportsList.find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  r.resolved = true;
  notifyAdmins('report_resolved', { id: r.id });
  res.json({ ok: true });
});

app.post('/api/admin/kick/:socketId', adminAuth, (req, res) => {
  const target = io.sockets.sockets.get(req.params.socketId);
  if (!target) return res.status(404).json({ error: 'Not found' });
  target.emit('kicked', { reason: 'Removed by admin.' });
  disconnectPair(req.params.socketId);
  removeFromQueue(req.params.socketId);
  target.disconnect(true);
  res.json({ ok: true });
});

// STATIC
app.use(express.static(path.join(__dirname, 'public')));
app.get('/',         (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/entrance', (_, res) => res.sendFile(path.join(__dirname, 'public', 'entrance.html')));
app.get('/chat',     (_, res) => res.sendFile(path.join(__dirname, 'public', 'chat.html')));
app.get('/admin',    (_, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// SOCKET.IO
io.on('connection', (socket) => {
  const ip = getIP(socket);
  if (!activeIPs.has(ip)) activeIPs.set(ip, new Set());
  activeIPs.get(ip).add(socket.id);
  broadcastOnline();

  socket.on('admin_join', (token) => {
    if (token !== ADMIN_TOKEN) return socket.emit('admin_auth_fail');
    socket.join('admins');
    socket.emit('admin_auth_ok');
    socket.emit('stats', buildStats());
    socket.emit('reports_list', reportsList.slice().reverse());
  });

  socket.on('find_stranger', (data) => {
    userMeta.set(socket.id, { name: data.name || 'სტრეინჯერი', gender: data.gender || '', age: data.age || '', ip });
    disconnectPair(socket.id);
    tryMatch(socket);
  });

  socket.on('next', (data) => {
    userMeta.set(socket.id, { name: data.name || 'სტრეინჯერი', gender: data.gender || '', age: data.age || '', ip });
    disconnectPair(socket.id);
    removeFromQueue(socket.id);
    tryMatch(socket);
  });

  socket.on('leave_chat', () => { disconnectPair(socket.id); removeFromQueue(socket.id); });

  socket.on('message', (data) => {
    const partnerId = pairs.get(socket.id);
    if (!partnerId) return;
    const text = String(data.text || '').slice(0, 2000);
    logMessage(socket.id, text);
    io.to(partnerId).emit('message', { text });
  });

  socket.on('typing',      () => { const p = pairs.get(socket.id); if (p) io.to(p).emit('typing'); });
  socket.on('stop_typing', () => { const p = pairs.get(socket.id); if (p) io.to(p).emit('stop_typing'); });

  socket.on('report', () => {
    const partnerId = pairs.get(socket.id);
    if (!partnerId) return;

    const chatId    = pairToChat.get(socket.id) || 'unknown';
    const myMeta    = userMeta.get(socket.id)   || {};
    const theirMeta = userMeta.get(partnerId)   || {};
    const log       = chatLogs.get(chatId)      || [];

    const report = {
      id:           'r_' + Date.now() + '_' + Math.random().toString(36).slice(2,6),
      ts:           new Date().toISOString(),
      reporterName: myMeta.name    || 'unknown',
      reportedName: theirMeta.name || 'unknown',
      reportedIp:   theirMeta.ip   || 'unknown',
      reportedSocketId: partnerId,
      chatId,
      chatLog:      [...log],
      resolved:     false,
    };
    reportsList.push(report);
    notifyAdmins('new_report', report);

    const timesReported = reportsList.filter(r => r.reportedName === theirMeta.name && !r.resolved).length;
    if (timesReported >= 3) {
      io.to(partnerId).emit('kicked', { reason: 'Removed due to multiple reports.' });
      const kicked = io.sockets.sockets.get(partnerId);
      if (kicked) { disconnectPair(partnerId); removeFromQueue(partnerId); kicked.disconnect(true); }
    }
  });

  socket.on('disconnect', () => {
    disconnectPair(socket.id);
    removeFromQueue(socket.id);
    const ipSet = activeIPs.get(ip);
    if (ipSet) { ipSet.delete(socket.id); if (ipSet.size === 0) activeIPs.delete(ip); }
    userMeta.delete(socket.id);
    broadcastOnline();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🟢  Running: http://localhost:${PORT}`);
  console.log(`🔑  Admin password: ${ADMIN_PASSWORD}`);
  console.log(`🛡️   Admin panel: http://localhost:${PORT}/admin`);
});
