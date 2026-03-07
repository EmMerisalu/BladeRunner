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
  minBlueGap: 900,

  // ---------- added for timer‑based spawn placement ----------
  gameWidth: 2000    // must match server's gameWidth
  // -----------------------------------------------------------
};
CONFIG.trackHeight = CONFIG.lanesPerTrack * CONFIG.laneHeight + CONFIG.trackSpacing;
const PLAYER_COLORS = ["cyan", "orange", "lime", "magenta"];

// ===============================
// SOUND
// ===============================
function playMoveSound() {
  const sound = new Audio('/sounds/move.wav');
  sound.volume = isMuted ? 0 : 1;
  sound.play();
}

const winSound = new Audio('/sounds/win.wav');
winSound.volume = 1;
winSound.load();

function playWinSound() {
  winSound.currentTime = 0;
  winSound.volume = isMuted ? 0 : 1;
  winSound.play().catch(e => console.log('Win sound failed:', e));
}

const minusHpSound = new Audio('/sounds/minus-hp.wav');
minusHpSound.volume = 1;
minusHpSound.load();

function playMinusHpSound() {
  minusHpSound.currentTime = 0;
  minusHpSound.volume = isMuted ? 0 : 1;
  minusHpSound.play().catch(e => console.log('Minus HP sound failed:', e));
}

const bgMusic = new Audio('/sounds/Pixel-Peeker-Polka-faster(chosic.com).mp3');
bgMusic.loop = true;
bgMusic.volume = 0.2;
bgMusic.load();

let isMuted = false;

function startBgMusic() {
  bgMusic.volume = isMuted ? 0 : 0.2;
  bgMusic.play().catch(e => console.log('BG music failed:', e));
}

function stopBgMusic() {
  bgMusic.pause();
  bgMusic.currentTime = 0;
}

function toggleSound() {
  isMuted = !isMuted;
  bgMusic.volume = isMuted ? 0 : 0.2;
  winSound.volume = isMuted ? 0 : 1;
  minusHpSound.volume = isMuted ? 0 : 1;
  updateSoundButton();
}

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
    sessionStorage.setItem('playerId', myId);
  }

  if (msg.type === "gameState") {
    state.timer = msg.timer;
    state.speed = msg.speed;

    msg.players.forEach(sp => {
      serverPlayers[sp.id] = sp;

      if (players[sp.id]) {
        if (sp.id === myId && sp.hp < players[sp.id].hp) {
          playMinusHpSound();
        }
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

    syncObstaclesFromServer(msg.obstacles || [], msg.blueSets || []);
  }

  if (msg.type === "pauseState") {
    state.paused = msg.paused;
    showPauseOverlay(msg.paused, msg.pausedBy);
  }

  if (msg.type === 'gameOver') {
    showGameOver(msg.winner || "No one", msg.playerTimes || []);
  }

  // Obstacle visuals are synced from gameState snapshots only.

  if (msg.type === "playerQuit") {
    showNotification(`${msg.name} has quit`);
  }
}

// ===============================
// SCALE GAME AREA TO FIT ALL TRACKS
// ===============================
function scaleGameArea() {
  const trackCount = Object.keys(players).length;
  const totalHeight = trackCount * CONFIG.trackHeight - CONFIG.trackSpacing;
  const scaleY = Math.min(1, window.innerHeight / totalHeight);
  const scaleX = scaleY;
  const el = document.getElementById("gameArea");
  el.style.transformOrigin = "top left";
  el.style.transform = `scale(${scaleX}, ${scaleY})`;
  const unscaledWidth = window.innerWidth / scaleX;
  // we keep CONFIG.gameWidth fixed (2000) for obstacle placement, but scale the container
  el.style.width = unscaledWidth + "px";
  // do NOT overwrite CONFIG.gameWidth
}

// ===============================
// INIT GAME
// ===============================
function initGame() {
  // Ensure any previous music is stopped before starting new game
  stopBgMusic();
  
  const waitForPlayers = setInterval(() => {
    if (myId !== null && serverPlayers[myId]) {
      clearInterval(waitForPlayers);
      setupPlayers();
      createTrackLines();   // <-- now includes top double lines
      scaleGameArea();
      state.running = true;
      startBgMusic();
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
// TRACK LINES (with double top lines)
// ===============================
function createTrackLines() {
  const container = document.getElementById("trackLines");
  const trackCount = Object.keys(serverPlayers).length;

  for (let t = 0; t < trackCount; t++) {
    const trackTop = t * CONFIG.trackHeight;

    // ---- Top double line for every track except the very first ----
    if (t > 0) {
      const top1 = document.createElement("div");
      top1.classList.add("track-top");
      top1.style.top = trackTop + "px";
      top1.style.background = PLAYER_COLORS[t];
      container.appendChild(top1);

      const top2 = document.createElement("div");
      top2.classList.add("track-top");
      top2.style.top = trackTop + 6 + "px";
      top2.style.background = PLAYER_COLORS[t];
      container.appendChild(top2);
    }

    // ---- Lane lines ----
    for (let i = 1; i < CONFIG.lanesPerTrack; i++) {
      const line = document.createElement("div");
      line.classList.add("track-line");
      line.style.top = trackTop + i * CONFIG.laneHeight + "px";
      line.style.background = PLAYER_COLORS[t];
      container.appendChild(line);
    }

    // ---- Bottom double line (unchanged) ----
    const bottom1 = document.createElement("div");
    bottom1.classList.add("track-bottom");
    bottom1.style.top = trackTop + CONFIG.lanesPerTrack * CONFIG.laneHeight + "px";
    bottom1.style.background = PLAYER_COLORS[t];
    container.appendChild(bottom1);

    const bottom2 = document.createElement("div");
    bottom2.classList.add("track-bottom");
    bottom2.style.top =
      trackTop + CONFIG.lanesPerTrack * CONFIG.laneHeight + 6 + "px";
    bottom2.style.background = PLAYER_COLORS[t];
    container.appendChild(bottom2);
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

  const ind = p.indicatorEl;
  if (ind) {
    ind.renderY = lerp(ind.renderY ?? p.renderY, p.renderY, 1 - Math.pow(0.001, delta));
  }
}

// ===============================
// SPAWNING (called by server events)
// ===============================
function spawnRedObstacle(track, lane, serverId, spawnTimer) {   // <-- added spawnTimer
  const el = document.createElement("div");
  el.classList.add("obstacle", "red");
  el.style.width = CONFIG.obstacleWidth + "px";
  el.style.height = CONFIG.laneHeight + "px";
  gameEl.appendChild(el);

  // ---------- timer‑based initial X ----------
  const age = Math.max(0, state.timer - spawnTimer);
  const startX = CONFIG.gameWidth - state.speed * age;
  // -------------------------------------------

  obstacles.push({
    kind: "red",
    serverId,
    track,
    lane,
    x: startX,
    width: CONFIG.obstacleWidth,
    el,
    // removed hit flag (no client collision)
  });
}

function spawnBlueObstacleSet(track, direction, serverId, spawnTimer) {   // <-- added spawnTimer
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

  const age = Math.max(0, state.timer - spawnTimer);
  const startX = CONFIG.gameWidth - state.speed * age;

  obstacles.push({
    kind: "blue",
    serverId,
    track,
    x: startX,
    group,
    width: CONFIG.obstacleWidth,
    direction,
    resolved: false   // used only for visual feedback
  });
}

function findObstacle(kind, serverId) {
  return obstacles.find(ob => ob.kind === kind && ob.serverId === serverId);
}

function syncObstaclesFromServer(serverRed, serverBlue) {
  const seen = new Set();

  serverRed.forEach(ob => {
    const key = `red:${ob.id}`;
    seen.add(key);

    let local = findObstacle("red", ob.id);
    if (!local) {
      spawnRedObstacle(ob.track, ob.lane, ob.id, state.timer);
      local = findObstacle("red", ob.id);
    }

    if (!local) return;
    local.track = ob.track;
    local.lane = ob.lane;
    local.x = ob.x;
    local.width = ob.width || CONFIG.obstacleWidth;
  });

  serverBlue.forEach(ob => {
    const key = `blue:${ob.id}`;
    seen.add(key);

    let local = findObstacle("blue", ob.id);
    if (!local) {
      spawnBlueObstacleSet(ob.track, ob.direction, ob.id, state.timer);
      local = findObstacle("blue", ob.id);
    }

    if (!local) return;
    local.track = ob.track;
    local.direction = ob.direction;
    local.x = ob.x;
    local.width = ob.width || CONFIG.obstacleWidth;
  });

  obstacles = obstacles.filter(ob => {
    const key = `${ob.kind}:${ob.serverId}`;
    if (seen.has(key)) return true;

    if (ob.kind === "red") {
      ob.el.remove();
    } else if (ob.kind === "blue") {
      ob.group.forEach(g => g.el.remove());
    }
    return false;
  });
}

// ===============================
// UPDATE OBSTACLES
// ===============================
function getTrackTop(trackIndex) {
  return trackIndex * CONFIG.trackHeight;
}

function updateObstacles(delta) {
  obstacles = obstacles.filter(ob => {

    if (ob.kind === "red") {
      ob.el.style.top = getTrackTop(ob.track) + ob.lane * CONFIG.laneHeight + "px";
      ob.el.style.left = ob.x + "px";

      // ---------- removed client‑side hit detection ----------
      // (no collision check, no "hit" message)
      // -------------------------------------------------------

      return true;
    }

    if (ob.kind === "blue") {
      ob.group.forEach(g => {
        g.el.style.top = getTrackTop(ob.track) + g.lane * CONFIG.laneHeight + "px";
        g.el.style.left = ob.x + "px";
      });

      // ---------- visual feedback only (no damage) ----------
      const myPlayer = players[myId];
      if (myPlayer && myPlayer.track === ob.track && !ob.resolved) {
        const dist = ob.x - myPlayer.x;
        if (dist < CONFIG.blueHitWindow && dist > -CONFIG.blueForgiveness) {
          ob.resolved = true;   // mark to avoid repeated checks
          if (myPlayer.dodge === ob.direction) {
            ob.group.forEach(g => g.el.style.background = "limegreen");
          } else {
            ob.group.forEach(g => g.el.style.background = "red");
            // no hit message sent – damage handled by server
          }
        }
      }
      // -------------------------------------------------------

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

  // Sound button
  let soundBtn = document.getElementById("soundBtn");
  if (!soundBtn) {
    soundBtn = document.createElement("button");
    soundBtn.id = "soundBtn";
    soundBtn.onclick = toggleSound;
    document.getElementById("ui").appendChild(soundBtn);
  }
  updateSoundButton();
}

function updateSoundButton() {
  const soundBtn = document.getElementById("soundBtn");
  if (soundBtn) {
    soundBtn.textContent = isMuted ? "🔇 Sound: Off" : "🔊 Sound: On";
  }
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
  // Play win sound if this player won
  if (winner !== "No one" && winner === serverPlayers[myId]?.name) {
    playWinSound();
  }

  // Stop background music
  stopBgMusic();

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

    const header = document.createElement("div");
    header.style.display = "flex";
    header.style.justifyContent = "space-between";
    header.style.fontWeight = "bold";
    header.style.padding = "5px 10px";
    header.style.borderBottom = "1px solid #444";
    header.innerHTML = "<span>Player</span><span>Time</span>";
    table.appendChild(header);

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
    const pid = sessionStorage.getItem('playerId');   // <-- ADD THIS
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

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    lastTime = performance.now(); // reset delta
  }
});

// ===============================
// INPUT
// ===============================
let holdingLeft = false;
let holdingRight = false;

document.addEventListener("keydown", (e) => {
  const myPlayer = players[myId];
  if (!myPlayer || myPlayer.falling) return;

  if (e.key === "a" || e.key === "ArrowLeft") {
    if (!holdingLeft) { holdingLeft = true; myPlayer.dodge = "left"; sendInput("dodgeLeft");}
  }
  if (e.key === "d" || e.key === "ArrowRight") {
    if (!holdingRight) { holdingRight = true; myPlayer.dodge = "right"; sendInput("dodgeRight");}
  }
  if (e.key === "w" || e.key === "ArrowUp") {
    if (myPlayer.lane > 0) { myPlayer.lane--; sendInput("laneUp"); playMoveSound(); }
  }
  if (e.key === "s" || e.key === "ArrowDown") {
    if (myPlayer.lane < CONFIG.lanesPerTrack - 1) { myPlayer.lane++; sendInput("laneDown"); playMoveSound(); }
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