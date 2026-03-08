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
  medium: {
    spawnIntervalMin: 350,
    spawnIntervalMax: 1000,
    minBlueGap: 950
  },
  hard: {
    spawnIntervalMin: 250,
    spawnIntervalMax: 900,
    minBlueGap: 900
  }
};

const OBSTACLE_BATCH_SIZE = {
  easy: 4,
  medium: 5,
  hard: 6
};

const BOT_DIFFICULTY_PROFILE = {
  easy: {
    decisionMin: 0.24,
    decisionMax: 0.72,
    executeChance: 0.62,
    awarenessRange: 320,
    laneWeight: 0.9,
    dodgeWeight: 0.85,
    chaos: 0.28,
    effectiveness: 45
  },
  medium: {
    decisionMin: 0.18,
    decisionMax: 0.5,
    executeChance: 0.82,
    awarenessRange: 440,
    laneWeight: 1,
    dodgeWeight: 1,
    chaos: 0.14,
    effectiveness: 70
  },
  hard: {
    decisionMin: 0.015,
    decisionMax: 0.04,
    executeChance: 0.9997,
    awarenessRange: 1050,
    laneWeight: 1.5,
    dodgeWeight: 1.5,
    chaos: 0.002,
    effectiveness: 100
  }
};

const BOT_NAME_PREFIX = ['Steel', 'Nova', 'Shadow', 'Turbo', 'Alpha', 'Ghost', 'Neon', 'Echo', 'Delta', 'Viper'];
const BOT_NAME_SUFFIX = ['Runner', 'Rider', 'Dash', 'Bolt', 'Drift', 'Byte', 'Spark', 'Flux', 'Core', 'Wing'];

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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function sanitizeDifficulty(value) {
  const normalized = String(value || '').toLowerCase();
  if (normalized === 'easy' || normalized === 'medium' || normalized === 'hard') {
    return normalized;
  }
  return 'medium';
}

function generateBotName(takenNames = new Set()) {
  let attempts = 0;
  while (attempts < 30) {
    attempts++;
    const candidate = `${BOT_NAME_PREFIX[Math.floor(Math.random() * BOT_NAME_PREFIX.length)]} ${BOT_NAME_SUFFIX[Math.floor(Math.random() * BOT_NAME_SUFFIX.length)]}`;
    if (!takenNames.has(candidate)) {
      takenNames.add(candidate);
      return candidate;
    }
  }

  const fallback = `Bot ${Math.floor(100 + Math.random() * 900)}`;
  takenNames.add(fallback);
  return fallback;
}

function calculateEffectiveness(profile) {
  const byDifficulty = BOT_DIFFICULTY_PROFILE[profile.difficulty] || BOT_DIFFICULTY_PROFILE.medium;
  return byDifficulty.effectiveness;
}

function normalizeBotProfile(rawProfile, index, takenNames = new Set()) {
  const difficulty = sanitizeDifficulty(rawProfile?.difficulty);
  const requestedName = String(rawProfile?.name || '').trim().slice(0, 16);
  const name = requestedName || generateBotName(takenNames);

  const profile = {
    name,
    difficulty
  };

  return {
    ...profile,
    effectiveness: calculateEffectiveness(profile)
  };
}

function defaultBotProfiles(botCount) {
  const defaults = ['easy', 'medium', 'hard'];
  const takenNames = new Set();
  return Array.from({ length: botCount }, (_, index) => normalizeBotProfile({ difficulty: defaults[index] || 'medium' }, index, takenNames));
}

function buildBotRuntime(profile) {
  const base = BOT_DIFFICULTY_PROFILE[profile.difficulty] || BOT_DIFFICULTY_PROFILE.medium;
  // Keep hard bots consistently deadly while preserving variance for easier modes.
  const jitter = profile.difficulty === 'hard'
    ? Math.random() * 0.02
    : (Math.random() - 0.5) * 0.12;

  return {
    profile,
    decisionTimer: Math.random() * 0.25,
    decisionMin: base.decisionMin,
    decisionMax: base.decisionMax,
    executeChance: clamp(base.executeChance + jitter, 0.35, 0.9995),
    awarenessRange: clamp(base.awarenessRange + Math.round(jitter * 220), 220, 1100),
    laneWeight: base.laneWeight,
    dodgeWeight: base.dodgeWeight,
    chaos: clamp(base.chaos + Math.abs(jitter) * 0.5, 0.04, 0.4)
  };
}

function getHumans(lobby) {
  return Object.values(lobby.players).filter(p => !p.isBot);
}

function getHumanCount(lobby) {
  return getHumans(lobby).length;
}

function pickNextHost(lobby) {
  const humans = getHumans(lobby);
  lobby.hostId = humans.length > 0 ? humans[0].id : null;
}

function addSinglePlayerBotsToLobby(lobby) {
  if (!lobby.singlePlayer) return;
  const existingBots = Object.values(lobby.players).filter(p => p.isBot);
  if (existingBots.length > 0) return;

  const botProfiles = lobby.botProfiles.length > 0 ? lobby.botProfiles : defaultBotProfiles(lobby.botCount);
  botProfiles.forEach((profile, index) => {
    const id = lobby.nextPlayerId++;
    lobby.players[id] = {
      id,
      name: profile.name,
      ready: true,
      track: index + 1,
      ws: null,
      isBot: true,
      botProfile: profile,
      ai: buildBotRuntime(profile)
    };
  });
}

function removeAllBots(lobby) {
  Object.keys(lobby.players).forEach((playerId) => {
    const p = lobby.players[playerId];
    if (p && p.isBot) delete lobby.players[playerId];
  });
}

function createLobby(settings = {}) {
  const singlePlayer = Boolean(settings.singlePlayer);
  const requestedBotCount = Number(settings.botCount) || 1;
  const botCount = singlePlayer ? clamp(Math.round(requestedBotCount), 1, 3) : 0;
  const requestedBots = Array.isArray(settings.bots) ? settings.bots : [];
  const takenNames = new Set();
  const botProfiles = singlePlayer
    ? (requestedBots.length > 0 ? requestedBots.slice(0, botCount).map((b, i) => normalizeBotProfile(b, i, takenNames)) : defaultBotProfiles(botCount))
    : [];

  const id = Math.random().toString(36).slice(2, 8);
  lobbies[id] = {
    players: {},
    started: false,
    mode: 'medium',
    hostId: null,
    singlePlayer,
    botCount,
    botProfiles,
    gameState: freshGameState(),
    nextPlayerId: 1,
    loopInterval: null,
    lastTick: null,
    lastBroadcastAt: 0
  };
  return id;
}

app.post('/create-lobby', (req, res) => {
  const id = createLobby(req.body || {});
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
  // Keep bot choices server-authoritative and in sync with current obstacle positions.
  updateBotsForLobby(lobbyId);

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
      isBot: Boolean(p.isBot),
      lane: 1,
      dodge: null,
      hp: 5,
      maxHp: 5,
      falling: false,
      ai: p.isBot ? buildBotRuntime(p.botProfile || normalizeBotProfile({}, p.track || 0)) : null
    };
  });
}

function findNearestRedThreat(gameState, track, fromX, horizon) {
  let nearest = null;
  let minDist = Infinity;
  for (const ob of gameState.obstacles) {
    if (ob.track !== track) continue;
    const dist = ob.x - fromX;
    if (dist < -CONFIG.blueForgiveness || dist > horizon) continue;
    if (dist < minDist) {
      minDist = dist;
      nearest = ob;
    }
  }
  return nearest;
}

function findNearestBlueThreat(gameState, track, fromX, horizon) {
  let nearest = null;
  let minDist = Infinity;
  for (const bs of gameState.blueSets) {
    if (bs.track !== track) continue;
    const dist = bs.x - fromX;
    if (dist < -CONFIG.blueForgiveness || dist > horizon) continue;
    if (dist < minDist) {
      minDist = dist;
      nearest = bs;
    }
  }
  return nearest;
}

function scoreLaneRisk(gameState, track, lane, fromX, horizon) {
  let risk = 0;
  for (const ob of gameState.obstacles) {
    if (ob.track !== track || ob.lane !== lane) continue;
    const dist = ob.x - fromX;
    if (dist < -CONFIG.blueForgiveness || dist > horizon) continue;
    // Strongly prioritize immediate threats over far-away ones.
    risk += 1 / Math.max(10, dist + 10);
    risk += 1 / Math.max(40, (dist + 25) * (dist + 25));
  }
  return risk;
}

function chooseBestLane(gameState, player, ai) {
  const horizon = ai.awarenessRange * ai.laneWeight;
  let bestLane = player.lane;
  let bestScore = scoreLaneRisk(gameState, player.track, player.lane, CONFIG.playerX, horizon);

  for (let lane = 0; lane < CONFIG.lanesPerTrack; lane++) {
    const laneRisk = scoreLaneRisk(gameState, player.track, lane, CONFIG.playerX, horizon);
    const movePenalty = Math.abs(lane - player.lane) * 0.012;
    const chaos = (Math.random() - 0.5) * ai.chaos * 0.04;
    const score = laneRisk + movePenalty + chaos;
    if (score < bestScore) {
      bestScore = score;
      bestLane = lane;
    }
  }

  return bestLane;
}

function applyBotDecision(gameState, player) {
  if (!player.ai || player.falling) return;
  const ai = player.ai;
  const isHard = ai.profile?.difficulty === 'hard';

  ai.decisionTimer -= CONFIG.tickRate / 1000;
  if (ai.decisionTimer > 0) return;
  ai.decisionTimer = ai.decisionMin + Math.random() * (ai.decisionMax - ai.decisionMin);

  const canExecute = Math.random() <= ai.executeChance;
  const nearestBlue = findNearestBlueThreat(gameState, player.track, CONFIG.playerX, ai.awarenessRange * ai.dodgeWeight);
  if (nearestBlue) {
    const blueDist = nearestBlue.x - CONFIG.playerX;
    const criticalBlue = isHard && blueDist < 340;
    if (canExecute || criticalBlue) {
      player.dodge = nearestBlue.direction;
    } else if (Math.random() < 0.5) {
      player.dodge = nearestBlue.direction === 'left' ? 'right' : 'left';
    } else {
      player.dodge = null;
    }
    // Hard bots should commit to the correct dodge more aggressively.
    if (isHard && blueDist < 420) {
      player.dodge = nearestBlue.direction;
    }
  } else if (Math.random() < 0.4 + ai.chaos * 0.3) {
    player.dodge = null;
  }

  const nearestRed = findNearestRedThreat(gameState, player.track, CONFIG.playerX, ai.awarenessRange);
  if (!nearestRed) {
    if (Math.random() < ai.chaos * 0.35) {
      const randomLane = Math.floor(Math.random() * CONFIG.lanesPerTrack);
      if (randomLane !== player.lane) player.lane = randomLane;
    }
    return;
  }

  const bestLane = chooseBestLane(gameState, player, ai);
  if (bestLane === player.lane) return;

  const redDist = nearestRed.x - CONFIG.playerX;
  const criticalRed = isHard && redDist < 420;

  if (canExecute || criticalRed) {
    player.lane = bestLane;
    return;
  }

  // Failed execution: still move, but often to a suboptimal neighboring lane.
  const direction = bestLane > player.lane ? 1 : -1;
  const fallbackLane = clamp(player.lane + direction, 0, CONFIG.lanesPerTrack - 1);
  player.lane = Math.random() < 0.6 ? fallbackLane : player.lane;
}

function updateBotsForLobby(lobbyId) {
  const lobby = lobbies[lobbyId];
  if (!lobby) return;
  const gameState = lobby.gameState;
  Object.values(gameState.players).forEach((p) => {
    if (!p.isBot || p.falling) return;
    applyBotDecision(gameState, p);
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
      isBot: p.isBot,
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
    track: p.track,
    isBot: Boolean(p.isBot),
    botProfile: p.isBot ? p.botProfile : null
  }));
  broadcastToLobby(lobbyId, {
    type: "lobby",
    players: snapshot,
    hostId: lobby.hostId,
    mode: lobby.mode,
    singlePlayer: lobby.singlePlayer
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
    if (p.ws && p.ws.readyState === 1) p.ws.send(msg);
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

    if (!gamePlayer || gamePlayer.isBot) {
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
        pickNextHost(lobby);
        broadcastHostChange(lobbyId);
      }

      if (getHumanCount(lobby) === 0) {
        removeAllBots(lobby);
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

  if (lobby.singlePlayer && getHumanCount(lobby) >= 1) {
    ws.send(JSON.stringify({ type: 'rejected', reason: 'Single-player lobby is offline-only' }));
    ws.close();
    return;
  }

  if (Object.keys(lobby.players).length >= 4) {
    ws.send(JSON.stringify({ type: 'rejected', reason: 'Lobby is full' }));
    ws.close();
    return;
  }

  const id = lobby.nextPlayerId++;
  const track = Object.keys(lobby.players).filter((playerId) => !lobby.players[playerId].isBot).length;
  const isHost = lobby.hostId === null;

  lobby.players[id] = { id, name: null, ready: false, track, ws, isBot: false, botProfile: null };
  if (isHost) {
    lobby.hostId = id;
    if (lobby.singlePlayer) {
      addSinglePlayerBotsToLobby(lobby);
    }
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
      pickNextHost(lobby);
      // let clients know about the new leader separately
      broadcastHostChange(lobbyId);
    }

    if (getHumanCount(lobby) === 0 && !lobby.started) {
      removeAllBots(lobby);
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
  const sender = lobby.players[id];
  if (!sender || sender.isBot) return;
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }

  if (msg.type === 'setName') {
    const requestedName = String(msg.name || '').trim().slice(0, 16);
    if (!requestedName) return;
    const nameTaken = Object.values(lobby.players).some(p => p.id !== id && p.name === requestedName);
    if (nameTaken) {
      lobby.players[id].ws.send(JSON.stringify({ type: 'nameTaken' }));
      return;
    }
    lobby.players[id].name = requestedName;
    broadcastLobbyFor(lobbyId);
  }

  if (msg.type === 'ready') {
    lobby.players[id].ready = !lobby.players[id].ready;
    broadcastLobbyFor(lobbyId);
  }

  if (msg.type === 'setGameMode') {
    if (id !== lobby.hostId) return;
    const requestedMode = String(msg.mode || '').toLowerCase();
    if (requestedMode !== 'easy' && requestedMode !== 'medium' && requestedMode !== 'hard') return;
    lobby.mode = requestedMode;
    broadcastLobbyFor(lobbyId);
  }

  if (msg.type === 'startGame') {
    const players = Object.values(lobby.players);
    const totalPlayers = players.length;
    const canStart =
      id === lobby.hostId &&
      totalPlayers >= 2 &&
      totalPlayers <= 4 &&
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

const PORT = 80;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});