const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");

const app = express();
app.use(express.static("client"));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ===============================
// CONFIG
// ===============================
const CONFIG = {
  baseSpeed: 650,
  speedIncreaseInterval: 8000,
  speedIncreaseAmount: 60,
  lanesPerTrack: 3,
  playerX: 150,
  playerWidth: 40
};
CONFIG.tickRate = 1000 / 60;

// ===============================
// GAME STATE
// ===============================
function freshGameState() {
  return {
    running: false,
    paused: false,
    pausedBy: null,
    timer: 0,
    speed: CONFIG.baseSpeed,
    lastSpeedIncrease: 0,
    players: {},
    winner: null
  };
}

let gameState = freshGameState();

// ===============================
// LOBBY STATE
// ===============================
const lobby = {
  players: {},
  started: false,
  hostId: null
};

let nextPlayerId = 1;

// ===============================
// GAME LOOP
// ===============================
let lastTick = null;

function startGameLoop() {
  lastTick = Date.now();
  gameState.running = true;

  setInterval(() => {
    if (!gameState.running) return;
    if (gameState.paused) return;

    const now = Date.now();
    const delta = (now - lastTick) / 1000;
    lastTick = now;

    tick(delta);
  }, CONFIG.tickRate);
}

function tick(delta) {
  gameState.timer += delta;

  gameState.lastSpeedIncrease += delta * 1000;
  if (gameState.lastSpeedIncrease >= CONFIG.speedIncreaseInterval) {
    gameState.speed += CONFIG.speedIncreaseAmount;
    gameState.lastSpeedIncrease = 0;
  }

  checkWinner();
  broadcastGameState();
}

// ===============================
// PLAYERS
// ===============================
function initGamePlayers() {
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

function loseHP(p) {
  if (p.falling) return;
  p.hp--;
  if (p.hp <= 0) p.falling = true;
}

// ===============================
// WINNER CHECK
// ===============================
function checkWinner() {
  if (gameState.winner) return;

  const all = Object.values(gameState.players);
  const alive = all.filter(p => !p.falling);
  const fallen = all.filter(p => p.falling);

  if (fallen.length === 0) return;

  if (all.length === 1 && alive.length === 0) {
    gameState.winner = "No one";
    gameState.running = false;
    broadcast({ type: "gameOver", winner: "No one" });
    return;
  }

  if (all.length > 1 && alive.length === 1) {
    gameState.winner = alive[0].name;
    gameState.running = false;
    broadcast({ type: "gameOver", winner: gameState.winner });
  }

  if (all.length > 1 && alive.length === 0) {
    gameState.winner = "No one";
    gameState.running = false;
    broadcast({ type: "gameOver", winner: "No one" });
  }
}

// ===============================
// BROADCAST
// ===============================
function broadcastGameState() {
  broadcast({
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

function broadcastLobby() {
  const snapshot = Object.values(lobby.players).map(p => ({
    id: p.id,
    name: p.name,
    ready: p.ready,
    track: p.track
  }));
  broadcast({ type: "lobby", players: snapshot, hostId: lobby.hostId });
}

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  Object.values(lobby.players).forEach(p => {
    if (p.ws.readyState === 1) p.ws.send(msg);
  });
}

// ===============================
// CONNECTIONS
// ===============================
wss.on("connection", (ws) => {
  if (lobby.started && !gameState.winner) {
    ws.send(JSON.stringify({ type: "rejected", reason: "Game already started" }));
    ws.close();
    return;
  }

  if (Object.keys(lobby.players).length >= 4) {
    ws.send(JSON.stringify({ type: "rejected", reason: "Lobby is full" }));
    ws.close();
    return;
  }

  const id = nextPlayerId++;
  const track = Object.keys(lobby.players).length;
  const isHost = lobby.hostId === null;

  lobby.players[id] = { id, name: null, ready: false, track, ws };
  if (isHost) lobby.hostId = id;

  ws.send(JSON.stringify({ type: "welcome", id, track, isHost }));
  broadcastLobby();

  ws.on("message", (raw) => handleMessage(id, raw));

  ws.on("close", () => {
    delete lobby.players[id];

    if (lobby.hostId === id) {
      const remaining = Object.keys(lobby.players);
      lobby.hostId = remaining.length > 0 ? Number(remaining[0]) : null;
    }

    if (Object.keys(lobby.players).length === 0) {
      lobby.started = false;
      lobby.hostId = null;
      gameState = freshGameState();
      console.log("All players left — lobby reset");
    }

    broadcastLobby();
  });
});

// ===============================
// MESSAGE HANDLER
// ===============================
function handleMessage(id, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }

  if (msg.type === "setName") {
    const nameTaken = Object.values(lobby.players).some(p => p.id !== id && p.name === msg.name);
    if (nameTaken) {
      lobby.players[id].ws.send(JSON.stringify({ type: "nameTaken" }));
      return;
    }
    lobby.players[id].name = msg.name;
    broadcastLobby();
  }

  if (msg.type === "ready") {
    lobby.players[id].ready = !lobby.players[id].ready;
    broadcastLobby();
  }

  if (msg.type === "startGame") {
    const players = Object.values(lobby.players);
    const canStart =
      id === lobby.hostId &&
      players.length >= 1 &&
      players.every(p => p.name) &&
      players.every(p => p.ready);

    if (canStart) {
      lobby.started = true;
      initGamePlayers();
      startGameLoop();
      broadcast({ type: "start" });
    }
  }

  // Client reports collision — server deducts HP
  if (msg.type === "hit") {
    const p = gameState.players[id];
    if (p) loseHP(p);
  }

  // Client syncs its player state to server
  if (msg.type === "input") {
    const p = gameState.players[id];
    if (!p || p.falling) return;

    if (msg.action === "laneUp" && p.lane > 0) p.lane--;
    if (msg.action === "laneDown" && p.lane < CONFIG.lanesPerTrack - 1) p.lane++;
    if (msg.action === "dodgeLeft") p.dodge = "left";
    if (msg.action === "dodgeRight") p.dodge = "right";
    if (msg.action === "dodgeNone") p.dodge = null;
  }

  if (msg.type === "pause") {
    if (!gameState.running && !gameState.paused) return;
    const playerName = gameState.players[id]?.name || lobby.players[id]?.name;
    gameState.paused = !gameState.paused;
    gameState.pausedBy = gameState.paused ? playerName : null;
    if (!gameState.paused) lastTick = Date.now();
    broadcast({
      type: "pauseState",
      paused: gameState.paused,
      pausedBy: gameState.pausedBy
    });
  }

  if (msg.type === "quit") {
    const playerName = gameState.players[id]?.name || lobby.players[id]?.name;
    broadcast({ type: "playerQuit", name: playerName });
    const p = gameState.players[id];
    if (p) p.falling = true;
  }
}

// ===============================
// START SERVER
// ===============================
const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});