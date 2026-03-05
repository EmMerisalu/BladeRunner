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
  paused: false
};

let obstacles = [];
const players = {};
const gameEl = document.getElementById("gameArea");

// ===============================
// WEBSOCKET
// ===============================
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
        players[sp.id].track = sp.track;

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

  if (msg.type === 'gameOver') {
    showGameOver(msg.winner || "No one", msg.playerTimes || []);
  }

  if (msg.type === "spawnObstacle") {
    if (msg.kind === "red") {
      spawnRedObstacle(msg.track, msg.lane, msg.id);
    } else if (msg.kind === "blue") {
      spawnBlueObstacleSet(msg.track, msg.direction, msg.id);
    }
  }

  if (msg.type === "playerQuit") {
    showNotification(`${msg.name} has quit`);
  }
}

// ===============================
// SCALE GAME AREA TO FIT ALL TRACKS
// ===============================
function scaleGameArea() {
  const trackCount = Object.keys(players).length;
  const totalHeight = trackCount * (CONFIG.lanesPerTrack * CONFIG.laneHeight + CONFIG.trackSpacing) - CONFIG.trackSpacing;
  const scaleY = Math.min(1, window.innerHeight / totalHeight);
  const scaleX = scaleY;
  const el = document.getElementById("gameArea");
  el.style.transformOrigin = "top left";
  el.style.transform = `scale(${scaleX}, ${scaleY})`;
  const unscaledWidth = window.innerWidth / scaleX;
  el.style.width = unscaledWidth + "px";
  CONFIG.gameWidth = unscaledWidth;
}

// ===============================
// INIT GAME
// ===============================
function initGame() {
  const waitForPlayers = setInterval(() => {
    if (myId !== null && serverPlayers[myId]) {
      clearInterval(waitForPlayers);
      setupPlayers();
      createTrackLines();
      scaleGameArea();
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
  p.handEmojiEl = handEmoji;

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
  const trackCount = Object.keys(serverPlayers).length;
  for (let t = 0; t < trackCount; t++) {
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
  Object.values(players).forEach(p => updatePlayer(p, delta));
  updateObstacles(delta);
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

  // Update indicator renderY here where delta is available
  const ind = p.indicatorEl;
  if (ind) {
    ind.renderY = lerp(ind.renderY ?? p.renderY, p.renderY, 1 - Math.pow(0.001, delta));
  }
}

// ===============================
// SPAWNING (called by server events)
// ===============================
function spawnRedObstacle(track, lane, serverId) {
  const el = document.createElement("div");
  el.classList.add("obstacle", "red");
  el.style.width = CONFIG.obstacleWidth + "px";
  el.style.height = CONFIG.laneHeight + "px";
  gameEl.appendChild(el);

  obstacles.push({
    kind: "red",
    serverId,
    track,
    lane,
    x: CONFIG.gameWidth || window.innerWidth,
    width: CONFIG.obstacleWidth,
    el,
    hit: false
  });
}

function spawnBlueObstacleSet(track, direction, serverId) {
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
    serverId,
    track,
    x: CONFIG.gameWidth || window.innerWidth,
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

    if (ob.kind === "red") {
      ob.el.style.top = getTrackTop(ob.track) + ob.lane * CONFIG.laneHeight + "px";
      ob.el.style.left = ob.x + "px";

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
        g.el.style.left = ob.x + "px";
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
      ind.style.top = (ind.renderY ?? p.renderY) + CONFIG.laneHeight * 0.2 + "px";
      if (p.dodge === "left") {
        ind.style.left = p.x - 22 + "px";
        p.handEmojiEl.style.transform = "rotate(-15deg)";
      } else {
        ind.style.left = p.x + p.width + "px";
        p.handEmojiEl.style.transform = "rotate(15deg)";
      }
    } else {
      ind.style.display = "none";
    }
  });

  const timerEl = document.getElementById("timer");
  if (timerEl) timerEl.textContent = "Time: " + state.timer.toFixed(1);

  let scoreboard = document.getElementById("scoreboard");
  if (!scoreboard) {
    scoreboard = document.createElement("div");
    scoreboard.id = "scoreboard";
    document.getElementById("ui").appendChild(scoreboard);
  }

  // Build/update scoreboard rows without rebuilding innerHTML every frame
  Object.values(serverPlayers).forEach(sp => {
    let row = document.getElementById("sb-" + sp.id);
    if (!row) {
      row = document.createElement("div");
      row.id = "sb-" + sp.id;
      row.style.color = PLAYER_COLORS[sp.track];
      if (sp.id === myId) row.style.fontWeight = "bold";
      scoreboard.appendChild(row);
    }
    const hearts = "❤️".repeat(Math.max(0, sp.hp)) + "🖤".repeat(sp.maxHp - Math.max(0, sp.hp));
    const newText = `${sp.name}: ${hearts}`;
    if (row.textContent !== newText) row.textContent = newText;
  });
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

function showGameOver(winner, playerTimes = []) {
  const overlay = document.createElement("div");
  overlay.id = "gameOverOverlay";
  overlay.style = `
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.9);
    display: flex; justify-content: center; align-items: center;
    z-index: 200; flex-direction: column; color: white;
    font-family: sans-serif;
  `;

  const winnerMsg = document.createElement("div");
  winnerMsg.style.fontSize = "36px";
  winnerMsg.style.marginBottom = "16px";
  winnerMsg.style.color = "gold";
  winnerMsg.textContent = winner === "No one" ? "It's a draw!" : `🏆 ${winner} wins!`;
  overlay.appendChild(winnerMsg);

  if (playerTimes.length > 0) {
    const table = document.createElement("div");
    table.style.margin = "20px 0";
    table.style.width = "300px";
    table.style.background = "#222";
    table.style.borderRadius = "8px";
    table.style.padding = "10px";

    // Header
    const header = document.createElement("div");
    header.style.display = "flex";
    header.style.justifyContent = "space-between";
    header.style.fontWeight = "bold";
    header.style.padding = "5px 10px";
    header.style.borderBottom = "1px solid #444";
    header.innerHTML = "<span>Player</span><span>Time</span>";
    table.appendChild(header);

    // Sort by time descending (longest survival first)
    const sorted = [...playerTimes].sort((a, b) => b.time - a.time);

    sorted.forEach(p => {
      const row = document.createElement("div");
      row.style.display = "flex";
      row.style.justifyContent = "space-between";
      row.style.padding = "5px 10px";
      row.innerHTML = `<span>${p.name}</span><span>${p.time.toFixed(1)}s</span>`;
      table.appendChild(row);
    });

    overlay.appendChild(table);
  }

  const btn = document.createElement("button");
  btn.textContent = "Back to Lobby";
  btn.style = `
    margin-top: 24px;
    padding: 12px 32px;
    font-size: 18px;
    background: gold;
    color: black;
    border: none;
    border-radius: 8px;
    cursor: pointer;
  `;
  btn.onclick = () => {
    const params = new URLSearchParams(window.location.search);
    const lobbyId = params.get('lobby');
    if (lobbyId) {
      window.location.href = `/lobby?lobby=${encodeURIComponent(lobbyId)}`;
    } else {
      window.location.href = '/';
    }
  };
  overlay.appendChild(btn);

  document.body.appendChild(overlay);
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