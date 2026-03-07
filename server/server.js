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
  playerWidth: 40,
  spawnIntervalMin: 250,
  spawnIntervalMax: 900,
  minBlueGap: 900,
  //  added for server‑side collision
  gameWidth: 2000,               // logical width, must match client
  blueHitWindow: 110,
  blueForgiveness: 40,
  obstacleWidth: 40
};

const MODE_CONFIG = {
   easy: {
    spawnIntervalMin: 500,
    spawnIntervalMax: 1200,
    minBlueGap: 1000
  },
  hard: {
    spawnIntervalMin: 250,
    spawnIntervalMax: 900,
    minBlueGap: 900
  }
};

const OBSTACLE_BATCH_SIZE = {
  easy: 4,
  hard: 6
};

const OBSTACLE_BROADCAST_LOOKAHEAD = 1200;
const GAMESTATE_BROADCAST_INTERVAL_MS = 33; 
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
    survivalTimes: {},
    lastSpawn: 0,
    nextSpawnInterval: 0,
    lastBlueSpawn: -9999,
    nextObstacleId: 1,
    //  added for server‑side obstacle tracking
    obstacles: [],      // red obstacles
    blueSets: []        // blue obstacle sets
  };
}

const lobbies = {};

function createLobby() {
  const id = Math.random().toString(36).slice(2, 8);
  lobbies[id] = {
    players: {},
    started: false,
    mode: 'easy',
    hostId: null,
    gameState: freshGameState(),
    nextPlayerId: 1,
    loopInterval: null,
    lastTick: null,
    lastBroadcastAt: 0
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

function getModeSettings(mode) {
  return MODE_CONFIG[mode] || MODE_CONFIG.easy;
}

function getRandomSpawnInterval(speed, mode) {
  const settings = getModeSettings(mode);
  const chaos = Math.random() ** 2;
  const speedFactor = Math.max(0.5, 1 - speed / 3000);
  return (settings.spawnIntervalMin +
    chaos * (settings.spawnIntervalMax - settings.spawnIntervalMin)) * speedFactor;
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

  // obstacle movement
  const speed = gameState.speed;
  gameState.obstacles.forEach(ob => ob.x -= speed * delta);
  gameState.blueSets.forEach(bs => bs.x -= speed * delta);

  // remove off‑screen obstacles
  gameState.obstacles = gameState.obstacles.filter(ob => ob.x > -ob.width);
  gameState.blueSets = gameState.blueSets.filter(bs => bs.x > -bs.width);
  // 

  //red obstacle collision
  for (const ob of gameState.obstacles) {
    for (const p of Object.values(gameState.players)) {
      if (p.falling) continue;
      if (p.track !== ob.track || p.lane !== ob.lane) continue;

      const playerLeft = CONFIG.playerX;
      const playerRight = CONFIG.playerX + CONFIG.playerWidth;
      const obLeft = ob.x;
      const obRight = ob.x + ob.width;

      if (playerRight > obLeft && playerLeft < obRight) {
        loseHP(p, gameState);
        ob.hit = true;   // mark for removal
        break;
      }
    }
  }
  gameState.obstacles = gameState.obstacles.filter(ob => !ob.hit);

  // ---------- blue set collision ----------
  for (const bs of gameState.blueSets) {
    for (const p of Object.values(gameState.players)) {
      if (p.falling) continue;
      if (p.track !== bs.track) continue;
      if (bs.processedPlayers.has(p.id)) continue;

      const dist = bs.x - CONFIG.playerX;
      if (dist < CONFIG.blueHitWindow && dist > -CONFIG.blueForgiveness) {
        bs.processedPlayers.add(p.id);
        if (p.dodge !== bs.direction) {
          loseHP(p, gameState);
        }
      }
    }
  }

  // ---------- spawning in batches to reduce generation churn ----------
  gameState.lastSpawn += delta * 1000;
  if (gameState.lastSpawn >= gameState.nextSpawnInterval) {
    const wavesPerBatch = OBSTACLE_BATCH_SIZE[lobby.mode] || OBSTACLE_BATCH_SIZE.easy;
    const nextBatchDelay = spawnObstaclesFor(lobbyId, wavesPerBatch);
    gameState.lastSpawn = 0;
    gameState.nextSpawnInterval = nextBatchDelay;
  }
  // 

  checkWinnerLobby(lobbyId);
  const nowMs = Date.now();
  if (nowMs - lobby.lastBroadcastAt >= GAMESTATE_BROADCAST_INTERVAL_MS) {
    lobby.lastBroadcastAt = nowMs;
    broadcastGameStateFor(lobbyId);
  }
}

function spawnObstaclesFor(lobbyId, waveCount = 1) {
  const lobby = lobbies[lobbyId];
  if (!lobby) return;
  const gameState = lobby.gameState;
  const modeSettings = getModeSettings(lobby.mode);
  const activeTracks = Object.values(gameState.players).map(p => p.track);

  let accumulatedSpawnDelayMs = 0;

  for (let wave = 0; wave < waveCount; wave++) {
    if (wave > 0) {
      accumulatedSpawnDelayMs += getRandomSpawnInterval(gameState.speed, lobby.mode);
    }

    const plannedSpawnMs = gameState.timer * 1000 + accumulatedSpawnDelayMs;
    const allowBlue = plannedSpawnMs - gameState.lastBlueSpawn > modeSettings.minBlueGap;
    const spawnX = CONFIG.gameWidth + gameState.speed * (accumulatedSpawnDelayMs / 1000);

    if (Math.random() < 0.6 || !allowBlue) {
      const sharedLane = Math.floor(Math.random() * CONFIG.lanesPerTrack);
      activeTracks.forEach(track => {
        const id = gameState.nextObstacleId++;
        const obstacle = {
          id,
          kind: 'red',
          track,
          lane: sharedLane,
          x: spawnX,
          width: CONFIG.obstacleWidth
        };
        gameState.obstacles.push(obstacle);
      });
    } else {
      const direction = Math.random() > 0.5 ? 'left' : 'right';
      activeTracks.forEach(track => {
        const id = gameState.nextObstacleId++;
        const blueSet = {
          id,
          kind: 'blue',
          track,
          direction,
          x: spawnX,
          width: CONFIG.obstacleWidth,
          processedPlayers: new Set()
        };
        gameState.blueSets.push(blueSet);
      });
      gameState.lastBlueSpawn = plannedSpawnMs;
    }
  }

  // Add one more gap so the next batch doesn't overlap this batch's last wave.
  const handoffGapMs = getRandomSpawnInterval(gameState.speed, lobby.mode);
  return Math.max(1, accumulatedSpawnDelayMs + handoffGapMs);
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

  // Record survival times for any newly fallen players
  fallen.forEach(p => {
    if (!gameState.survivalTimes[p.id]) {
      gameState.survivalTimes[p.id] = gameState.timer;
    }
  });

  // Only end the game when no one is alive
  if (alive.length === 0) {
    // All players are dead – determine the winner based on longest survival time
    let winnerName = "No one";
    let longestTime = -1;

    Object.values(gameState.players).forEach(p => {
      const time = gameState.survivalTimes[p.id] || 0;
      if (time > longestTime) {
        longestTime = time;
        winnerName = p.name;
      } else if (time === longestTime && time !== -1) {
        // tie – keep "No one" or could be multiple winners, but we'll keep "No one"
        winnerName = "No one";
      }
    });

    gameState.winner = winnerName;
    // Reset ready status for all players so they must ready up again
    Object.values(lobby.players).forEach(p => { p.ready = false; });
    gameState.running = false;

    const playerTimes = Object.values(gameState.players).map(p => ({
      name: p.name,
      time: gameState.survivalTimes[p.id] || 0
    }));
//
    broadcastToLobby(lobbyId, {
      type: "gameOver",
      winner: winnerName,
      playerTimes
    });

    // Reset lobby so players can start another game
    lobby.started = false;
    if (lobby.loopInterval) {
      clearInterval(lobby.loopInterval);
      lobby.loopInterval = null;
    }
  }
}

function broadcastGameStateFor(lobbyId) {
  const lobby = lobbies[lobbyId];
  if (!lobby) return;
  const gameState = lobby.gameState;
  const visibleMaxX = CONFIG.gameWidth + OBSTACLE_BROADCAST_LOOKAHEAD;

  broadcastToLobby(lobbyId, {
    type: "gameState",
    timer: gameState.timer,
    speed: gameState.speed,
    paused: gameState.paused,
    pausedBy: gameState.pausedBy,
    obstacles: gameState.obstacles
      .filter(ob => ob.x <= visibleMaxX)
      .map(ob => ({
      id: ob.id,
      kind: ob.kind,
      track: ob.track,
      lane: ob.lane,
      x: ob.x,
      width: ob.width
    })),
    blueSets: gameState.blueSets
      .filter(bs => bs.x <= visibleMaxX)
      .map(bs => ({
      id: bs.id,
      kind: bs.kind,
      track: bs.track,
      direction: bs.direction,
      x: bs.x,
      width: bs.width
    })),
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
  broadcastToLobby(lobbyId, {
    type: "lobby",
    players: snapshot,
    hostId: lobby.hostId,
    mode: lobby.mode
  });
}

function broadcastHostChange(lobbyId) {
  const lobby = lobbies[lobbyId];
  if (!lobby) return;
  broadcastToLobby(lobbyId, { type: 'hostChanged', hostId: lobby.hostId });
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
  let pid = null;
  try {
    const full = new URL(req.url, `http://${req.headers.host}`);
    lobbyId = full.searchParams.get('lobby');
    pid = full.searchParams.get('pid');
  } catch (e) {}

  if (!lobbyId || !lobbies[lobbyId]) {
    ws.send(JSON.stringify({ type: 'rejected', reason: 'Lobby not found' }));
    ws.close();
    return;
  }

  const lobby = lobbies[lobbyId];

  // During an active game, only known players can reconnect.
  if (lobby.started && !lobby.gameState.winner) {
    if (!pid) {
      ws.send(JSON.stringify({ type: 'rejected', reason: 'Game already started' }));
      ws.close();
      return;
    }

    const numPid = Number(pid);
    const gamePlayer = lobby.gameState.players[numPid];

    if (!gamePlayer) {
      ws.send(JSON.stringify({ type: 'rejected', reason: 'Game already started' }));
      ws.close();
      return;
    }

    // Update the stored WebSocket to the new connection
    // Re-add to lobby.players so broadcastToLobby can reach them
    lobby.players[numPid] = {
      id: numPid,
      name: gamePlayer.name,
      ready: true,
      track: gamePlayer.track,
      ws
    };

    ws.send(JSON.stringify({ type: 'welcome', id: numPid, track: gamePlayer.track, isHost: lobby.hostId === numPid }));
    ws.send(JSON.stringify({ type: 'started' }));

    ws.on('message', (raw) => handleMessageFor(lobbyId, numPid, raw));

    ws.on('close', () => {
      if (lobby.players[numPid]) delete lobby.players[numPid];

      if (lobby.hostId === numPid) {
        const remaining = Object.keys(lobby.players);
        lobby.hostId = remaining.length > 0 ? Number(remaining[0]) : null;
        broadcastHostChange(lobbyId);
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
  if (isHost) {
    lobby.hostId = id;
  }

  ws.send(JSON.stringify({ type: 'welcome', id, track, isHost }));
  broadcastLobbyFor(lobbyId);
  if (isHost) {
    broadcastHostChange(lobbyId);
  }

  ws.on('message', (raw) => handleMessageFor(lobbyId, id, raw));

  ws.on('close', () => {
    delete lobby.players[id];

    if (lobby.hostId === id) {
      const remaining = Object.keys(lobby.players);
      lobby.hostId = remaining.length > 0 ? Number(remaining[0]) : null;
      // let clients know about the new leader separately
      broadcastHostChange(lobbyId);
    }

    if (Object.keys(lobby.players).length === 0 && !lobby.started) {
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

  if (msg.type === 'setGameMode') {
    if (id !== lobby.hostId) return;
    const requestedMode = String(msg.mode || '').toLowerCase();
    if (requestedMode !== 'easy' && requestedMode !== 'hard') return;
    lobby.mode = requestedMode;
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
      // Reassign tracks sequentially so there are no gaps
      Object.values(lobby.players).forEach((p, i) => { p.track = i; });
      lobby.gameState = freshGameState();
      lobby.pendingStart = true;
      lobby.started = true;
      initGamePlayersFor(lobbyId);
      lobby.gameState.nextSpawnInterval = getRandomSpawnInterval(lobby.gameState.speed, lobby.mode);
      startGameLoopFor(lobbyId);
      broadcastToLobby(lobbyId, { type: 'start' });

      setTimeout(() => {
        if (!lobby.pendingStart) return;
        lobby.pendingStart = false;
        broadcastToLobby(lobbyId, { type: 'started' });
      }, 800);
    }
  }

  // ---------- removed client‑side hit handler ----------
  // if (msg.type === 'hit') { ... }   // DELETED
  // -----------------------------------------------------

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
app.use('/sounds', express.static(path.join(__dirname, '../client/sounds')));

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});