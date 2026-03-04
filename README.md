# შშშ... Anonymous Chat

Real-time anonymous Georgian chat app built with Node.js + Socket.IO.

## Stack
- **Backend**: Node.js + Express + Socket.IO
- **Frontend**: Vanilla HTML/CSS/JS (fonts embedded as base64)

## Features
- Anonymous matchmaking queue
- Real-time messaging
- Typing indicators
- Report system (auto-kick after 3 reports)
- Online user count
- Next / Leave / Report buttons

---

## Run locally

```bash
npm install
npm run dev      # uses nodemon for auto-reload
# or
npm start        # production
```

Open http://localhost:3000

---

## Deploy on Railway (RECOMMENDED — free, supports WebSockets)

1. Push this repo to GitHub
2. Go to https://railway.app → New Project → Deploy from GitHub
3. Select your repo
4. Railway auto-detects Node.js and runs `npm start`
5. Done — you get a live URL instantly

---

## Deploy on Render (also free)

1. Push to GitHub
2. Go to https://render.com → New → Web Service
3. Connect your repo
4. Build command: `npm install`
5. Start command: `npm start`
6. Done

---

## Deploy on Vercel ⚠️

Vercel **does not support persistent WebSocket connections** in serverless functions.
The app will work for HTTP but Socket.IO real-time features will be unreliable.

**Use Railway or Render instead.**

If you still want Vercel:
- Socket.IO will fall back to long-polling (slower but functional)
- The `vercel.json` is included and configured

---

## File structure

```
sss-chat/
├── server.js          ← main server (Express + Socket.IO)
├── package.json
├── vercel.json        ← Vercel config
├── .gitignore
├── README.md
└── public/
    ├── index.html     ← landing page
    ├── entrance.html  ← profile setup (name, gender, age)
    └── chat.html      ← chat page (Socket.IO client)
```
