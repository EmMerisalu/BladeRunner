// ===============================
// CONFIG
// ===============================
const CONFIG = {
  gravity: 2200,
  jumpForce: 850,

  baseSpeed: 650,
  speedIncreaseInterval: 8000,
  speedIncreaseAmount: 60,

  lanesPerTrack: 3,
  laneHeight: 80,
  trackSpacing: 40,
  trackCount: 4,

  playerX: 150,
  playerWidth: 40,
  obstacleWidth: 40,

  blueHitWindow: 110,
  blueForgiveness: 40,

  spawnIntervalMin: 250,
  spawnIntervalMax: 900,
  minBlueGap: 900
};

const PLAYER_COLORS = ["cyan", "orange", "lime", "magenta"];

// ===============================
// MULTIPLAYER STATE
// ===============================
let ws = null;
let myId = null;
let serverPlayers = {};

// ===============================
// LOCAL GAME STATE
// ===============================
let state = {
  running: false,
  speed: CONFIG.baseSpeed,
  timer: 0,
  lastSpawn: 0,
  lastSpeedIncrease: 0,
  nextSpawnInterval: 0,
  lastBlueSpawn: -9999,
  paused: false
};

let obstacles = [];
const players = {};
const gameEl = document.getElementById("gameArea");

// ===============================
// WEBSOCKET
// ===============================
function connectWebSocket() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${protocol}//${location.host}`);
  ws.onclose = () => showNotification("Disconnected from server. Please refresh.");
}

function sendInput(action) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: "input", action }));
  }
}

// ===============================
// HANDLE SERVER MESSAGES
// ===============================
function handleServerMessage(msg) {
  if (msg.type === "welcome") {
    myId = msg.id;
  }

  if (msg.type === "gameState") {
    state.timer = msg.timer;
    state.speed = msg.speed;

    msg.players.forEach(sp => {
      serverPlayers[sp.id] = sp;

      if (players[sp.id]) {
        players[sp.id].hp = sp.hp;
        players[sp.id].maxHp = sp.maxHp;
        players[sp.id].falling = sp.falling;

        if (sp.id !== myId) {
          players[sp.id].lane = sp.lane;
          players[sp.id].dodge = sp.dodge;
        }
      }
    });
  }

  if (msg.type === "pauseState") {
    state.paused = msg.paused;
    showPauseOverlay(msg.paused, msg.pausedBy);
  }

  if (msg.type === "gameOver") {
    state.running = false;
    showGameOver(msg.winner);
  }

  if (msg.type === "playerQuit") {
    showNotification(`${msg.name} has quit`);
  }
}

// ===============================
// INIT GAME
// ===============================
function initGame() {
  createTrackLines();
  state.nextSpawnInterval = getRandomSpawnInterval();

  const waitForPlayers = setInterval(() => {
    if (myId !== null && serverPlayers[myId]) {
      clearInterval(waitForPlayers);
      setupPlayers();
      state.running = true;
      startRenderLoop();
    }
  }, 50);
}

// ===============================
// SETUP PLAYERS
// ===============================
function setupPlayers() {
  Object.values(serverPlayers).forEach(sp => {
    createPlayer(sp.id, sp.track);
  });
}

function createPlayer(id, track) {
  if (players[id]) return;

  const color = PLAYER_COLORS[track];
  const p = {
    id,
    track,
    lane: 1,
    x: CONFIG.playerX,
    y: 0,
    width: CONFIG.playerWidth,
    height: CONFIG.laneHeight,
    velocityY: 0,
    jumping: false,
    ducking: false,
    falling: false,
    dodge: null,
    color,
    hp: 5,
    maxHp: 5,
    renderY: null,
    hpY: null
  };

  const el = document.createElement("div");
  el.classList.add("player");
  el.style.background = color;
  el.textContent = id === myId ? "😊" : "😈";
  gameEl.appendChild(el);
  p.el = el;

  const hpBar = document.createElement("div");
  hpBar.classList.add("hp-bar");
  gameEl.appendChild(hpBar);
  p.hpBarEl = hpBar;

  const indicator = document.createElement("div");
  indicator.classList.add("dodge-indicator");
  const handEmoji = document.createElement("div");
  handEmoji.classList.add("hand-emoji");
  handEmoji.textContent = "🖐️";
  indicator.appendChild(handEmoji);
  gameEl.appendChild(indicator);
  p.indicatorEl = indicator;

  const nameTag = document.createElement("div");
  nameTag.classList.add("name-tag");
  nameTag.textContent = serverPlayers[id]?.name || "";
  nameTag.style.color = id === myId ? "yellow" : "white";
  gameEl.appendChild(nameTag);
  p.nameTag = nameTag;

  players[id] = p;
}

// ===============================
// TRACK LINES
// ===============================
function createTrackLines() {
  const container = document.getElementById("trackLines");
  for (let t = 0; t < CONFIG.trackCount; t++) {
    const trackTop = t * (CONFIG.lanesPerTrack * CONFIG.laneHeight + CONFIG.trackSpacing);
    for (let i = 1; i < CONFIG.lanesPerTrack; i++) {
      const line = document.createElement("div");
      line.classList.add("track-line");
      line.style.top = trackTop + i * CONFIG.laneHeight + "px";
      line.style.background = PLAYER_COLORS[t];
      container.appendChild(line);
    }
    const bottom = document.createElement("div");
    bottom.classList.add("track-bottom");
    bottom.style.top = trackTop + CONFIG.lanesPerTrack * CONFIG.laneHeight + "px";
    bottom.style.background = PLAYER_COLORS[t];
    container.appendChild(bottom);
  }
}

// ===============================
// RENDER LOOP
// ===============================
let lastTime = 0;

function startRenderLoop() {
  function loop(timestamp) {
    const delta = Math.min((timestamp - lastTime) / 1000, 0.05);
    lastTime = timestamp;

    if (state.running && !state.paused) {
      update(delta);
    }
    render();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

// ===============================
// UPDATE
// ===============================
function update(delta) {
  state.lastSpawn += delta * 1000;
  state.lastSpeedIncrease += delta * 1000;

  if (state.lastSpeedIncrease >= CONFIG.speedIncreaseInterval) {
    state.speed += CONFIG.speedIncreaseAmount;
    state.lastSpeedIncrease = 0;
  }

  Object.values(players).forEach(p => updatePlayer(p, delta));
  updateObstacles(delta);

  if (state.lastSpawn >= state.nextSpawnInterval) {
    spawnRandomPattern();
    state.lastSpawn = 0;
    state.nextSpawnInterval = getRandomSpawnInterval();
  }
}

// ===============================
// PLAYER UPDATE
// ===============================
function updatePlayer(p, delta) {
  if (p.falling) return;

  if (p.jumping) {
    p.velocityY = -CONFIG.jumpForce;
    p.jumping = false;
  }

  if (p.velocityY !== 0 || p.y !== 0) {
    p.velocityY += CONFIG.gravity * delta;
    p.y += p.velocityY * delta;
    if (p.y >= 0) {
      p.y = 0;
      p.velocityY = 0;
    }
  }

  p.height = p.ducking ? CONFIG.laneHeight / 2 : CONFIG.laneHeight;

  const targetY = getTrackTop(p.track) + p.lane * CONFIG.laneHeight;
  p.renderY = lerp(p.renderY ?? targetY, targetY, Math.min(1, delta * 155));
  p.hpY = lerp(p.hpY ?? targetY, targetY, Math.min(1, delta * 15));
}

// ===============================
// SPAWNING
// ===============================
function getRandomSpawnInterval() {
  const chaos = Math.random() ** 2;
  const speedFactor = Math.max(0.5, 1 - state.speed / 3000);
  return (CONFIG.spawnIntervalMin +
    chaos * (CONFIG.spawnIntervalMax - CONFIG.spawnIntervalMin)) * speedFactor;
}

function spawnRandomPattern() {
  const now = state.timer * 1000;
  const allowBlue = now - state.lastBlueSpawn > CONFIG.minBlueGap;
  const activeTracks = Object.values(players).map(p => p.track);

  if (Math.random() < 0.6 || !allowBlue) {
    activeTracks.forEach(t => {
      const lane = Math.floor(Math.random() * 3);
      spawnRedObstacle(t, lane);
    });
  } else {
    activeTracks.forEach(t => spawnBlueObstacleSet(t));
    state.lastBlueSpawn = now;
  }
}

function spawnRedObstacle(track, lane) {
  const el = document.createElement("div");
  el.classList.add("obstacle", "red");
  el.style.width = CONFIG.obstacleWidth + "px";
  el.style.height = CONFIG.laneHeight + "px";
  gameEl.appendChild(el);

  obstacles.push({
    kind: "red",
    track,
    lane,
    x: window.innerWidth,
    renderX: window.innerWidth,
    width: CONFIG.obstacleWidth,
    el,
    hit: false
  });
}

function spawnBlueObstacleSet(track) {
  const direction = Math.random() > 0.5 ? "left" : "right";
  const group = [];

  for (let lane = 0; lane < CONFIG.lanesPerTrack; lane++) {
    const el = document.createElement("div");
    el.classList.add("obstacle", "blue");
    el.textContent = direction === "left" ? "◀" : "▶";
    el.style.width = CONFIG.obstacleWidth + "px";
    el.style.height = CONFIG.laneHeight + "px";
    gameEl.appendChild(el);
    group.push({ lane, el });
  }

  obstacles.push({
    kind: "blue",
    track,
    x: window.innerWidth,
    renderX: window.innerWidth,
    group,
    width: CONFIG.obstacleWidth,
    direction,
    resolved: false
  });
}

// ===============================
// UPDATE OBSTACLES
// ===============================
function getTrackTop(trackIndex) {
  return trackIndex * (CONFIG.lanesPerTrack * CONFIG.laneHeight + CONFIG.trackSpacing);
}

function updateObstacles(delta) {
  const move = state.speed * delta;

  obstacles = obstacles.filter(ob => {
    ob.x -= move;
    ob.renderX = lerp(ob.renderX ?? ob.x, ob.x, 0.6);

    if (ob.kind === "red") {
      ob.el.style.top = getTrackTop(ob.track) + ob.lane * CONFIG.laneHeight + "px";
      ob.el.style.left = ob.renderX + "px";

      const myPlayer = players[myId];
      if (myPlayer && myPlayer.track === ob.track && myPlayer.lane === ob.lane && !ob.hit && !myPlayer.falling) {
        let leniency = 0;
        if (state.timer > 10) {
          if (!ob.leniencyApplied) {
            ob.leniency = ob.width * 0.2;
            ob.leniencyApplied = true;
          }
          leniency = ob.leniency || 0;
        }

        const overlap =
          myPlayer.x + myPlayer.width > ob.x + leniency &&
          myPlayer.x < ob.x + ob.width - leniency;

        if (overlap) {
          ob.hit = true;
          if (ws && ws.readyState === 1) {
            ws.send(JSON.stringify({ type: "hit", kind: "red" }));
          }
        }
      }

      if (ob.x < -ob.width) {
        ob.el.remove();
        return false;
      }
      return true;
    }

    if (ob.kind === "blue") {
      ob.group.forEach(g => {
        g.el.style.top = getTrackTop(ob.track) + g.lane * CONFIG.laneHeight + "px";
        g.el.style.left = ob.renderX + "px";
      });

      const myPlayer = players[myId];
      if (myPlayer && myPlayer.track === ob.track && !ob.resolved) {
        const dist = ob.x - myPlayer.x;
        if (dist < CONFIG.blueHitWindow && dist > -CONFIG.blueForgiveness) {
          ob.resolved = true;
          if (myPlayer.dodge === ob.direction) {
            ob.group.forEach(g => g.el.style.background = "limegreen");
          } else {
            ob.group.forEach(g => g.el.style.background = "red");
            if (ws && ws.readyState === 1) {
              ws.send(JSON.stringify({ type: "hit", kind: "blue" }));
            }
          }
        }
      }

      if (ob.x < -ob.width) {
        ob.group.forEach(g => g.el.remove());
        return false;
      }
      return true;
    }

    return false;
  });
}

// ===============================
// RENDER
// ===============================
function render() {
  Object.values(players).forEach(p => {
    if (!p.el) return;

    p.el.style.height = p.height + "px";
    p.el.style.width = p.width + "px";
    p.el.style.top = (p.renderY ?? 0) + p.y + "px";
    p.el.style.left = p.x + "px";
    p.el.style.opacity = p.falling ? "0" : "1";

    const barWidth = 30;
    const bar = p.hpBarEl;
    bar.style.width = (p.hp / p.maxHp) * barWidth + "px";
    bar.style.left = p.x + (p.width - barWidth) / 2 + "px";
    bar.style.top = (p.hpY ?? 0) - 10 + "px";
    bar.style.opacity = p.falling ? "0" : "1";

    if (p.nameTag) {
      p.nameTag.style.left = p.x + "px";
      p.nameTag.style.top = (p.hpY ?? 0) - 26 + "px";
      p.nameTag.style.opacity = p.falling ? "0" : "1";
    }

    const ind = p.indicatorEl;
    if (!p.falling && p.dodge) {
      ind.style.display = "block";
      ind.renderY = lerp(ind.renderY ?? p.renderY, p.renderY, 0.25);
      ind.style.top = ind.renderY + CONFIG.laneHeight * 0.2 + "px";
      const handEmoji = ind.querySelector(".hand-emoji");
      if (p.dodge === "left") {
        ind.style.left = p.x - 22 + "px";
        handEmoji.style.transform = "rotate(-15deg)";
      } else {
        ind.style.left = p.x + p.width + "px";
        handEmoji.style.transform = "rotate(15deg)";
      }
    } else {
      ind.style.display = "none";
    }
  });

  const timerEl = document.getElementById("timer");
  if (timerEl) timerEl.innerText = "Time: " + state.timer.toFixed(1);

  let scoreboard = document.getElementById("scoreboard");
  if (!scoreboard) {
    scoreboard = document.createElement("div");
    scoreboard.id = "scoreboard";
    document.getElementById("ui").appendChild(scoreboard);
  }
  scoreboard.innerHTML = Object.values(serverPlayers).map(sp =>
    `<div style="color:${PLAYER_COLORS[sp.track]};${sp.id === myId ? "font-weight:bold" : ""}">
      ${sp.name}: ${"❤️".repeat(Math.max(0, sp.hp))}${"🖤".repeat(sp.maxHp - Math.max(0, sp.hp))}
    </div>`
  ).join("");
}

// ===============================
// LERP
// ===============================
function lerp(a, b, t) {
  return a + (b - a) * t;
}

// ===============================
// UI OVERLAYS
// ===============================
function showPauseOverlay(paused, pausedBy) {
  let overlay = document.getElementById("pauseOverlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "pauseOverlay";
    overlay.innerHTML = `
      <div id="pauseBox">
        <div id="pauseMsg"></div>
        <button id="resumeBtn">Resume</button>
        <button id="quitBtn">Quit</button>
      </div>`;
    document.body.appendChild(overlay);

    document.getElementById("resumeBtn").onclick = () => {
      ws.send(JSON.stringify({ type: "pause" }));
    };
    document.getElementById("quitBtn").onclick = () => {
      ws.send(JSON.stringify({ type: "quit" }));
    };
  }
  overlay.style.display = paused ? "flex" : "none";
  if (paused) {
    document.getElementById("pauseMsg").textContent = `${pausedBy} paused the game`;
  }
}

function showGameOver(winner) {
  let overlay = document.getElementById("gameOverOverlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "gameOverOverlay";
    overlay.innerHTML = `
      <div id="gameOverBox">
        <div id="winnerMsg"></div>
        <button onclick="location.reload()" style="
          margin-top: 24px;
          padding: 12px 32px;
          font-size: 18px;
          background: gold;
          color: black;
          border: none;
          border-radius: 8px;
          cursor: pointer;
        ">Back to Lobby</button>
      </div>`;
    document.body.appendChild(overlay);
  }
  overlay.style.display = "flex";
  document.getElementById("winnerMsg").textContent =
    winner === "No one" ? "It's a draw!" : `🏆 ${winner} wins!`;
}

function showNotification(text) {
  const notif = document.createElement("div");
  notif.classList.add("notification");
  notif.textContent = text;
  document.body.appendChild(notif);
  setTimeout(() => notif.remove(), 3000);
}

// ===============================
// INPUT
// ===============================
let holdingLeft = false;
let holdingRight = false;

document.addEventListener("keydown", (e) => {
  const myPlayer = players[myId];
  if (!myPlayer || myPlayer.falling) return;

  if (e.key === "a" || e.key === "ArrowLeft") {
    if (!holdingLeft) { holdingLeft = true; myPlayer.dodge = "left"; sendInput("dodgeLeft"); }
  }
  if (e.key === "d" || e.key === "ArrowRight") {
    if (!holdingRight) { holdingRight = true; myPlayer.dodge = "right"; sendInput("dodgeRight"); }
  }
  if (e.key === "w" || e.key === "ArrowUp") {
    if (myPlayer.lane > 0) { myPlayer.lane--; sendInput("laneUp"); }
  }
  if (e.key === "s" || e.key === "ArrowDown") {
    if (myPlayer.lane < CONFIG.lanesPerTrack - 1) { myPlayer.lane++; sendInput("laneDown"); }
  }
  if (e.key === " ") {
    if (myPlayer.y === 0) { myPlayer.jumping = true; sendInput("jump"); }
  }
  if (e.key === "Shift") {
    myPlayer.ducking = true; sendInput("duckOn");
  }
  if (e.key === "Escape") {
    ws && ws.send(JSON.stringify({ type: "pause" }));
  }
});

document.addEventListener("keyup", (e) => {
  const myPlayer = players[myId];

  if (e.key === "a" || e.key === "ArrowLeft") holdingLeft = false;
  if (e.key === "d" || e.key === "ArrowRight") holdingRight = false;

  if (!holdingLeft && !holdingRight) {
    if (myPlayer) myPlayer.dodge = null;
    sendInput("dodgeNone");
  } else if (holdingLeft) {
    if (myPlayer) myPlayer.dodge = "left";
    sendInput("dodgeLeft");
  } else {
    if (myPlayer) myPlayer.dodge = "right";
    sendInput("dodgeRight");
  }

  if (e.key === "Shift") {
    if (myPlayer) myPlayer.ducking = false;
    sendInput("duckOff");
  }
});