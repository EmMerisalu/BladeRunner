const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const path = require("path");
const { URL } = require('url');

const app = express();
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const CONFIG = {
  baseSpeed: 650,
  speedIncreaseInterval: 8000,
  speedIncreaseAmount: 60,
  lanesPerTrack: 3,
  playerX: 150,
  playerWidth: 40
};
CONFIG.tickRate = 1000 / 60;

function freshGameState() {
  return {
    running: false,
    paused: false,
    pausedBy: null,
    timer: 0,
    speed: CONFIG.baseSpeed,
    lastSpeedIncrease: 0,
    players: {},
    winner: null,
    survivalTimes: {}   // id -> time when player fell (or final for survivors)
  };
}

const lobbies = {};

function createLobby() {
  const id = Math.random().toString(36).slice(2, 8);
  lobbies[id] = {
    players: {},
    started: false,
    hostId: null,
    gameState: freshGameState(),
    nextPlayerId: 1,
    loopInterval: null,
    lastTick: null
  };
  return id;
}

app.post('/create-lobby', (req, res) => {
  const name = (req.body && req.body.name) ? String(req.body.name).trim() : null;
  const id = createLobby();
  res.json({ lobbyId: id, url: `/lobby?lobby=${id}` });
});

function startGameLoopFor(lobbyId) {
  const lobby = lobbies[lobbyId];
  if (!lobby) return;
  lobby.lastTick = Date.now();
  lobby.gameState.running = true;

  if (lobby.loopInterval) return;

  lobby.loopInterval = setInterval(() => {
    if (!lobby.gameState.running) return;
    if (lobby.gameState.paused) return;

    const now = Date.now();
    const delta = (now - lobby.lastTick) / 1000;
    lobby.lastTick = now;

    tickLobby(lobbyId, delta);
  }, CONFIG.tickRate);
}

function tickLobby(lobbyId, delta) {
  const lobby = lobbies[lobbyId];
  if (!lobby) return;
  const gameState = lobby.gameState;

  gameState.timer += delta;
  gameState.lastSpeedIncrease += delta * 1000;
  if (gameState.lastSpeedIncrease >= CONFIG.speedIncreaseInterval) {
    gameState.speed += CONFIG.speedIncreaseAmount;
    gameState.lastSpeedIncrease = 0;
  }

  checkWinnerLobby(lobbyId);
  broadcastGameStateFor(lobbyId);
}

function initGamePlayersFor(lobbyId) {
  const lobby = lobbies[lobbyId];
  if (!lobby) return;
  const gameState = lobby.gameState;
  gameState.players = {};
  gameState.survivalTimes = {};
  Object.values(lobby.players).forEach(p => {
    gameState.players[p.id] = {
      id: p.id,
      track: p.track,
      name: p.name,
      lane: 1,
      dodge: null,
      hp: 5,
      maxHp: 5,
      falling: false
    };
  });
}

function loseHP(p, gameState) {
  if (p.falling) return;
  p.hp--;
  if (p.hp <= 0) {
    p.falling = true;
    if (!gameState.survivalTimes[p.id]) {
      gameState.survivalTimes[p.id] = gameState.timer;
    }
  }
}

function checkWinnerLobby(lobbyId) {
  const lobby = lobbies[lobbyId];
  if (!lobby) return;
  const gameState = lobby.gameState;
  if (gameState.winner) return;

  const all = Object.values(gameState.players);
  const alive = all.filter(p => !p.falling);
  const fallen = all.filter(p => p.falling);

  fallen.forEach(p => {
    if (!gameState.survivalTimes[p.id]) {
      gameState.survivalTimes[p.id] = gameState.timer;
    }
  });

  if (fallen.length === 0) return;

  let gameEnded = false;
  let winnerName = null;

  if (all.length === 1 && alive.length === 0) {
    gameEnded = true;
    winnerName = "No one";
  } else if (all.length > 1 && alive.length === 1) {
    gameEnded = true;
    winnerName = alive[0].name;
  } else if (all.length > 1 && alive.length === 0) {
    gameEnded = true;
    winnerName = "No one";
  }

  if (gameEnded) {
    alive.forEach(p => {
      if (!gameState.survivalTimes[p.id]) {
        gameState.survivalTimes[p.id] = gameState.timer;
      }
    });

    gameState.winner = winnerName;
    gameState.running = false;

    const playerTimes = Object.values(gameState.players).map(p => ({
      name: p.name,
      time: gameState.survivalTimes[p.id] || 0
    }));

    broadcastToLobby(lobbyId, {
      type: "gameOver",
      winner: winnerName,
      playerTimes
    });
  }
}

function broadcastGameStateFor(lobbyId) {
  const lobby = lobbies[lobbyId];
  if (!lobby) return;
  const gameState = lobby.gameState;
  broadcastToLobby(lobbyId, {
    type: "gameState",
    timer: gameState.timer,
    speed: gameState.speed,
    paused: gameState.paused,
    pausedBy: gameState.pausedBy,
    players: Object.values(gameState.players).map(p => ({
      id: p.id,
      name: p.name,
      track: p.track,
      lane: p.lane,
      dodge: p.dodge,
      hp: p.hp,
      maxHp: p.maxHp,
      falling: p.falling
    }))
  });
}

function broadcastLobbyFor(lobbyId) {
  const lobby = lobbies[lobbyId];
  if (!lobby) return;
  const snapshot = Object.values(lobby.players).map(p => ({
    id: p.id,
    name: p.name,
    ready: p.ready,
    track: p.track
  }));
  broadcastToLobby(lobbyId, { type: "lobby", players: snapshot, hostId: lobby.hostId });
}

function broadcastToLobby(lobbyId, obj) {
  const lobby = lobbies[lobbyId];
  if (!lobby) return;
  const msg = JSON.stringify(obj);
  Object.values(lobby.players).forEach(p => {
    if (p.ws.readyState === 1) p.ws.send(msg);
  });
}

wss.on('connection', (ws, req) => {
  let lobbyId = null;
  try {
    const full = new URL(req.url, `http://${req.headers.host}`);
    lobbyId = full.searchParams.get('lobby');
  } catch (e) { /* ignore */ }

  if (!lobbyId || !lobbies[lobbyId]) {
    ws.send(JSON.stringify({ type: 'rejected', reason: 'Lobby not found' }));
    ws.close();
    return;
  }

  const lobby = lobbies[lobbyId];

  if (lobby.started && !lobby.gameState.winner) {
    ws.send(JSON.stringify({ type: 'rejected', reason: 'Game already started' }));
    ws.close();
    return;
  }

  if (Object.keys(lobby.players).length >= 4) {
    ws.send(JSON.stringify({ type: 'rejected', reason: 'Lobby is full' }));
    ws.close();
    return;
  }

  const id = lobby.nextPlayerId++;
  const track = Object.keys(lobby.players).length;
  const isHost = lobby.hostId === null;

  lobby.players[id] = { id, name: null, ready: false, track, ws };
  if (isHost) lobby.hostId = id;

  ws.send(JSON.stringify({ type: 'welcome', id, track, isHost }));
  broadcastLobbyFor(lobbyId);

  ws.on('message', (raw) => handleMessageFor(lobbyId, id, raw));

  ws.on('close', () => {
    delete lobby.players[id];

    if (lobby.hostId === id) {
      const remaining = Object.keys(lobby.players);
      lobby.hostId = remaining.length > 0 ? Number(remaining[0]) : null;
    }

    if (Object.keys(lobby.players).length === 0) {
      lobby.started = false;
      lobby.hostId = null;
      lobby.gameState = freshGameState();
      if (lobby.loopInterval) {
        clearInterval(lobby.loopInterval);
        lobby.loopInterval = null;
      }
      console.log(`All players left — lobby ${lobbyId} reset`);
    }

    broadcastLobbyFor(lobbyId);
  });
});

function handleMessageFor(lobbyId, id, raw) {
  const lobby = lobbies[lobbyId];
  if (!lobby) return;
  const gameState = lobby.gameState;
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }

  if (msg.type === 'setName') {
    const nameTaken = Object.values(lobby.players).some(p => p.id !== id && p.name === msg.name);
    if (nameTaken) {
      lobby.players[id].ws.send(JSON.stringify({ type: 'nameTaken' }));
      return;
    }
    lobby.players[id].name = msg.name;
    broadcastLobbyFor(lobbyId);
  }

  if (msg.type === 'ready') {
    lobby.players[id].ready = !lobby.players[id].ready;
    broadcastLobbyFor(lobbyId);
  }

  if (msg.type === 'startGame') {
    const players = Object.values(lobby.players);
    const canStart =
      id === lobby.hostId &&
      players.length >= 1 &&
      players.every(p => p.name) &&
      players.every(p => p.ready);

    if (canStart) {
      lobby.pendingStart = true;
      broadcastToLobby(lobbyId, { type: 'start' });

      setTimeout(() => {
        if (!lobby.pendingStart) return;
        lobby.pendingStart = false;
        lobby.started = true;
        initGamePlayersFor(lobbyId);
        startGameLoopFor(lobbyId);
        broadcastToLobby(lobbyId, { type: 'started' });
      }, 800);
    }
  }

  if (msg.type === 'hit') {
    const p = gameState.players[id];
    if (p) loseHP(p, gameState);
  }

  if (msg.type === 'input') {
    const p = gameState.players[id];
    if (!p || p.falling) return;

    if (msg.action === 'laneUp' && p.lane > 0) p.lane--;
    if (msg.action === 'laneDown' && p.lane < CONFIG.lanesPerTrack - 1) p.lane++;
    if (msg.action === 'dodgeLeft') p.dodge = 'left';
    if (msg.action === 'dodgeRight') p.dodge = 'right';
    if (msg.action === 'dodgeNone') p.dodge = null;
  }

  if (msg.type === 'pause') {
    if (!gameState.running && !gameState.paused) return;
    const playerName = gameState.players[id]?.name || lobby.players[id]?.name;
    gameState.paused = !gameState.paused;
    gameState.pausedBy = gameState.paused ? playerName : null;
    if (!gameState.paused) lobby.lastTick = Date.now();
    broadcastToLobby(lobbyId, {
      type: 'pauseState',
      paused: gameState.paused,
      pausedBy: gameState.pausedBy
    });
  }

  if (msg.type === 'quit') {
    const playerName = gameState.players[id]?.name || lobby.players[id]?.name;
    broadcastToLobby(lobbyId, { type: 'playerQuit', name: playerName });
    const p = gameState.players[id];
    if (p) {
      if (!gameState.survivalTimes[p.id]) {
        gameState.survivalTimes[p.id] = gameState.timer;
      }
      p.falling = true;
    }
  }
}

app.use('/', express.static(path.join(__dirname, '../client/menu')));
app.use('/game',  express.static(path.join(__dirname, '../client/game')));
app.use('/lobby', express.static(path.join(__dirname, '../client/lobby')));

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});