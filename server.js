const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling'],
});

// ── static files ─────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

app.get('/',           (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/entrance',   (_, res) => res.sendFile(path.join(__dirname, 'public', 'entrance.html')));
app.get('/chat',       (_, res) => res.sendFile(path.join(__dirname, 'public', 'chat.html')));

// ── in-memory state ───────────────────────────────────────
// waitingQueue: [{ socketId, name, gender, age }]
// pairs:        Map<socketId, socketId>
const waitingQueue = [];
const pairs        = new Map();   // socketId → partnerId
const userMeta     = new Map();   // socketId → { name, gender, age }
const reports      = new Map();   // reportedId → count

function onlineCount() {
  return io.engine.clientsCount;
}

function broadcastOnline() {
  io.emit('online_count', onlineCount());
}

function removeFromQueue(socketId) {
  const idx = waitingQueue.findIndex(u => u.socketId === socketId);
  if (idx !== -1) waitingQueue.splice(idx, 1);
}

function tryMatch(socket) {
  // find a waiting user that is NOT this socket
  const idx = waitingQueue.findIndex(u => u.socketId !== socket.id);
  if (idx === -1) {
    // nobody waiting — add self to queue
    if (!waitingQueue.find(u => u.socketId === socket.id)) {
      const meta = userMeta.get(socket.id) || {};
      waitingQueue.push({ socketId: socket.id, ...meta });
    }
    socket.emit('waiting');
    return;
  }

  const partner = waitingQueue.splice(idx, 1)[0];
  // remove self from queue if queued
  removeFromQueue(socket.id);

  // register pair
  pairs.set(socket.id, partner.socketId);
  pairs.set(partner.socketId, socket.id);

  const myMeta      = userMeta.get(socket.id)      || {};
  const partnerMeta = userMeta.get(partner.socketId) || {};

  // notify both
  socket.emit('matched',          { strangerName: partnerMeta.name || 'სტრეინჯერი' });
  io.to(partner.socketId).emit('matched', { strangerName: myMeta.name  || 'სტრეინჯერი' });
}

function disconnectPair(socketId) {
  const partnerId = pairs.get(socketId);
  pairs.delete(socketId);
  if (partnerId) {
    pairs.delete(partnerId);
    io.to(partnerId).emit('stranger_left');
  }
}

// ── socket.io ────────────────────────────────────────────
io.on('connection', (socket) => {
  broadcastOnline();

  socket.on('find_stranger', (data) => {
    // store meta
    userMeta.set(socket.id, {
      name:   data.name   || 'სტრეინჯერი',
      gender: data.gender || '',
      age:    data.age    || '',
    });

    // if already in a pair, leave it first
    disconnectPair(socket.id);
    tryMatch(socket);
  });

  socket.on('next', (data) => {
    userMeta.set(socket.id, {
      name:   data.name   || 'სტრეინჯერი',
      gender: data.gender || '',
      age:    data.age    || '',
    });
    disconnectPair(socket.id);
    removeFromQueue(socket.id);
    tryMatch(socket);
  });

  socket.on('leave_chat', () => {
    disconnectPair(socket.id);
    removeFromQueue(socket.id);
  });

  socket.on('message', (data) => {
    const partnerId = pairs.get(socket.id);
    if (!partnerId) return;
    const text = String(data.text || '').slice(0, 2000); // cap at 2k chars
    io.to(partnerId).emit('message', { text });
  });

  socket.on('typing', () => {
    const partnerId = pairs.get(socket.id);
    if (partnerId) io.to(partnerId).emit('typing');
  });

  socket.on('stop_typing', () => {
    const partnerId = pairs.get(socket.id);
    if (partnerId) io.to(partnerId).emit('stop_typing');
  });

  socket.on('report', () => {
    const partnerId = pairs.get(socket.id);
    if (!partnerId) return;
    const count = (reports.get(partnerId) || 0) + 1;
    reports.set(partnerId, count);
    console.log(`[report] ${partnerId} reported ${count} time(s)`);
    // auto-kick after 3 reports
    if (count >= 3) {
      io.to(partnerId).emit('kicked', { reason: 'You have been removed due to multiple reports.' });
      const kicked = io.sockets.sockets.get(partnerId);
      if (kicked) {
        disconnectPair(partnerId);
        removeFromQueue(partnerId);
        kicked.disconnect(true);
      }
    }
  });

  socket.on('disconnect', () => {
    disconnectPair(socket.id);
    removeFromQueue(socket.id);
    userMeta.delete(socket.id);
    broadcastOnline();
  });
});

// ── start ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🟢  სერვერი მუშაობს: http://localhost:${PORT}`);
});
