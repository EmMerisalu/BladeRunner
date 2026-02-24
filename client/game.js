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

let state = {
  running: true,
  speed: CONFIG.baseSpeed,
  timer: 0,
  lastSpawn: 0,
  lastSpeedIncrease: 0,
  nextSpawnInterval: 0,
  lastBlueSpawn: -9999
};

function getRandomSpawnInterval() {
  const chaos = Math.random() ** 2;
  const speedFactor = Math.max(0.5, 1 - state.speed / 3000);
  return (CONFIG.spawnIntervalMin +
    chaos * (CONFIG.spawnIntervalMax - CONFIG.spawnIntervalMin)) * speedFactor;
}

state.nextSpawnInterval = getRandomSpawnInterval();

let obstacles = [];
const players = [];
const gameEl = document.getElementById("game");

// ===============================
// Players
// ===============================
for (let i = 0; i < CONFIG.trackCount; i++) {
  const p = {
    track: i,
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
    color: PLAYER_COLORS[i],
    hp: 5,
    maxHp: 5
  };

  const el = document.createElement("div");
  el.classList.add("player");
  el.style.background = p.color;
  el.textContent = "😊";
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

  players.push(p);
}

const player1 = players[0];

// ===============================
// Track Lines
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

createTrackLines();

// ===============================
// Game Loop
// ===============================
let lastTime = 0;
function loop(timestamp) {
  const delta = (timestamp - lastTime) / 1000;
  lastTime = timestamp;

  if (state.running) {
    update(delta);
    render();
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// ===============================
// Update
// ===============================
function update(delta) {
  state.timer += delta;
  state.lastSpawn += delta * 1000;
  state.lastSpeedIncrease += delta * 1000;

  if (state.lastSpeedIncrease >= CONFIG.speedIncreaseInterval) {
    state.speed += CONFIG.speedIncreaseAmount;
    state.lastSpeedIncrease = 0;
  }

  players.forEach(p => updatePlayer(p, delta));
  updateObstacles(delta);

  if (state.lastSpawn >= state.nextSpawnInterval) {
    spawnRandomPattern();
    state.lastSpawn = 0;
    state.nextSpawnInterval = getRandomSpawnInterval();
  }
}

// ===============================
// Player Update
// ===============================
function updatePlayer(p, delta) {
  // Jumping
  if (p.jumping && !p.falling) {
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

  // Ducking
  p.height = p.ducking ? CONFIG.laneHeight / 2 : CONFIG.laneHeight;

  // Smooth lane movement
  const targetY = getTrackTop(p.track) + p.lane * CONFIG.laneHeight;

  // Increase playerSpeed to make lane movement faster
  const playerSpeed = 155; // was 12, higher = faster
  const hpSpeed = 15;      // slower = HP bar lags behind

  // lerp with min(1) to prevent overshoot
  p.renderY = lerp(p.renderY ?? targetY, targetY, Math.min(1, delta * playerSpeed));
  p.hpY = lerp(p.hpY ?? targetY, targetY, Math.min(1, delta * hpSpeed));
}

// Linear interpolation helper
function lerp(a, b, t) {
  return a + (b - a) * t;
}
// ===============================
// Spawning
// ===============================
function spawnRandomPattern() {
  const now = state.timer * 1000;
  const allowBlue = now - state.lastBlueSpawn > CONFIG.minBlueGap;

  if (Math.random() < 0.6 || !allowBlue) {
    for (let t = 0; t < CONFIG.trackCount; t++) {
      const lane = Math.floor(Math.random() * 3);
      spawnRedObstacle(t, lane);
    }
  } else {
    for (let t = 0; t < CONFIG.trackCount; t++) {
      spawnBlueObstacleSet(t);
    }
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
    group,
    width: CONFIG.obstacleWidth,
    direction,
    resolved: false
  });
}

// ===============================
// Update Obstacles
// ===============================
function getTrackTop(trackIndex) {
  return trackIndex * (CONFIG.lanesPerTrack * CONFIG.laneHeight + CONFIG.trackSpacing);
}

function updateObstacles(delta) {
  const move = state.speed * delta;
  obstacles.forEach((ob, index) => {
    ob.x -= move;

    if (ob.kind === "red") {
      ob.el.style.top = getTrackTop(ob.track) + ob.lane * CONFIG.laneHeight + "px";
      ob.el.style.left = ob.x + "px";

      players.forEach(p => {
        if (p.track === ob.track && p.lane === ob.lane && !ob.hit && !p.falling) {
          // Calculate leniency
          let leniency = 0;
          if (state.timer > 10) {  // after 10 seconds
            if (!ob.leniencyApplied) {
              ob.leniency = ob.width * 0.2; // shrink width by 20%
              ob.leniencyApplied = true;
            }
            leniency = ob.leniency;
          }

          // Correct overlap check
          const overlap =
            p.x + p.width > ob.x + leniency &&
            p.x < ob.x + ob.width - leniency;

          if (overlap) {
            ob.hit = true;
            loseHP(p);
          }
        }
      });

      if (ob.x < -ob.width) {
        ob.el.remove();
        obstacles.splice(index, 1);
      }
    }



    if (ob.kind === "blue") {
      ob.group.forEach(g => {
        g.el.style.top = getTrackTop(ob.track) + g.lane * CONFIG.laneHeight + "px";
        g.el.style.left = ob.x + "px";
      });

      players.forEach(p => {
        if (p.track !== ob.track || ob.resolved) return;
        const dist = ob.x - p.x;
        if (dist < CONFIG.blueHitWindow && dist > -CONFIG.blueForgiveness) {
          ob.resolved = true;
          if (p.dodge === ob.direction) {
            ob.group.forEach(g => g.el.style.background = "limegreen");
          } else {
            ob.group.forEach(g => g.el.style.background = "red");
            loseHP(p);
          }
        }
      });

      if (ob.x < -ob.width) {
        ob.group.forEach(g => g.el.remove());
        obstacles.splice(index, 1);
      }
    }
  });
}

// ===============================
// HP
// ===============================
function loseHP(p) {
  if (p.falling) return;

  p.hp--;
  if (p.hp <= 0) {
    p.falling = true;
    p.el.style.transition = "all 0.8s ease";
    p.el.style.opacity = 0;
    p.indicatorEl.style.opacity = 0;
    p.hpBarEl.style.opacity = 0;
    setTimeout(() => {
      p.el.remove();
      p.indicatorEl.remove();
      p.hpBarEl.remove();
    }, 800);
  }
}

// ===============================
// Render
// ===============================
function render() {
  players.forEach(p => {
    // Player body
    p.el.style.height = p.height + "px";
    p.el.style.width = p.width + "px";
    p.el.style.top = p.renderY + "px";
    p.el.style.left = p.x + "px";

    // HP bar follows slower
    const barWidth = 30;
    const bar = p.hpBarEl;
    bar.style.width = (p.hp / p.maxHp) * barWidth + "px";
    bar.style.left = p.x + (p.width - barWidth) / 2 + "px";
    bar.style.top = p.hpY - 10 + "px";

    // Hand dodge indicator
    const ind = p.indicatorEl;
    if (!p.falling && p.dodge) {
      ind.style.display = "block";

      // Smoothly follow player's Y movement
      ind.renderY = lerp(ind.renderY ?? p.renderY, p.renderY, 0.25); // matches player speed
      ind.style.top = ind.renderY + CONFIG.laneHeight * 0.2 + "px";

      const handEmoji = ind.querySelector(".hand-emoji");

      if (p.dodge === "left") {
        ind.style.left = p.x - 22 + "px";
        handEmoji.style.left = "-4px";
        handEmoji.style.transform = "rotate(-15deg)";
      } else {
        ind.style.left = p.x + p.width + "px";
        handEmoji.style.left = "0px";
        handEmoji.style.transform = "rotate(15deg)";
      }
    } else {
      ind.style.display = "none";
    }

  });

  document.getElementById("timer").innerText =
    "Time: " + state.timer.toFixed(1);

  let hpText = document.getElementById("hp-text");
  if (!hpText) {
    hpText = document.createElement("div");
    hpText.id = "hp-text";
    document.getElementById("ui").appendChild(hpText);
  }
  hpText.innerText =
    "HP: " + players[0].hp + "/" + players[0].maxHp;
}
// ===============================
// Input — HOLD BASED
// ===============================
let holdingLeft = false;
let holdingRight = false;

document.addEventListener("keydown", (e) => {
  if (e.key === "a" || e.key === "ArrowLeft") { holdingLeft = true; player1.dodge = "left"; }
  if (e.key === "d" || e.key === "ArrowRight") { holdingRight = true; player1.dodge = "right"; }
  if (e.key === "w" || e.key === "ArrowUp") { if (player1.lane > 0) player1.lane--; }
  if (e.key === "s" || e.key === "ArrowDown") { if (player1.lane < CONFIG.lanesPerTrack - 1) player1.lane++; }
  if (e.key === " ") { if (player1.y === 0) player1.jumping = true; }
  if (e.key === "Shift") player1.ducking = true;
});

document.addEventListener("keyup", (e) => {
  if (e.key === "a" || e.key === "ArrowLeft") holdingLeft = false;
  if (e.key === "d" || e.key === "ArrowRight") holdingRight = false;

  if (!holdingLeft && !holdingRight) player1.dodge = null;
  else if (holdingLeft) player1.dodge = "left";
  else player1.dodge = "right";

  if (e.key === "Shift") player1.ducking = false;
});
