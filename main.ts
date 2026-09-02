import {
  activeHueCount,
  ALL_HUES,
  circlesOverlap,
  cycleHue,
  fallSpeed,
  isFatalCollision,
  moveSpeed,
  spawnIntervalMs,
  type Hue,
  type Obstacle,
  type Player,
} from "./game-logic.ts";

const canvas = document.querySelector<HTMLCanvasElement>("#game")!;
const announcer = document.querySelector<HTMLElement>("#announcer")!;
const ctx = canvas.getContext("2d")!;

// Sky blue / amber survived a Machado-2009 CVD simulation (see the original
// two-hue comment this replaces); c/d extend the same Okabe-Ito-derived
// palette, chosen for the same reason --- bluish green and reddish purple
// both stay distinguishable from the first pair and from each other under
// protanopia, deuteranopia and tritanopia, unlike an arbitrary rainbow ramp.
const HUE_COLOR: Record<Hue, string> = {
  a: "#38bdf8",
  b: "#f59e0b",
  c: "#009e73",
  d: "#cc79a7",
};
const FIRST_SPAWN_DELAY_MS = 1200;
const MAX_DT = 0.05; // clamp so a backgrounded tab can't leap the sim forward

const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Synthesised, not sampled: three short tones cover swap/match/game-over
// without shipping an audio asset. Created lazily on the first real user
// gesture (a pointerdown or keydown always precedes any sound-triggering
// action) since browsers block audio until one occurs; muted state persists
// across visits via localStorage, defaulting on.
let audioCtx: AudioContext | null = null;
let soundOn = localStorage.getItem("two-tone-sound") !== "off";

function ensureAudio(): AudioContext | null {
  if (!soundOn) return null;
  if (!audioCtx) audioCtx = new AudioContext();
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

function beep(freq: number, durationMs: number, type: OscillatorType = "sine", gain = 0.08) {
  const ctx = ensureAudio();
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  g.gain.value = gain;
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + durationMs / 1000);
  osc.connect(g).connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + durationMs / 1000);
}

function playSwapSound() {
  beep(520, 90, "triangle");
}
function playMatchSound() {
  beep(880, 110, "sine", 0.06);
}
function playGameOverSound() {
  beep(160, 90, "sawtooth", 0.1);
  setTimeout(() => beep(110, 220, "sawtooth", 0.1), 90);
}
function playShieldUpSound() {
  beep(440, 70, "triangle", 0.07);
  setTimeout(() => beep(660, 120, "triangle", 0.07), 70);
}
function playShieldBreakSound() {
  beep(300, 160, "square", 0.09);
}
function playDashSound() {
  beep(700, 60, "square", 0.05);
}

function toggleSound() {
  soundOn = !soundOn;
  localStorage.setItem("two-tone-sound", soundOn ? "on" : "off");
  if (soundOn) ensureAudio();
}

let width = 0;
let height = 0;
let player: Player;
let swapButton: { x: number; y: number; radius: number };
let muteButton: { x: number; y: number; radius: number };
let neutralButton: { x: number; y: number; radius: number };
let obstacles: Obstacle[] = [];
let state: "playing" | "gameover" = "playing";
let elapsedSeconds = 0;
let matchedCount = 0;
let score = 0;
let spawnTimer = FIRST_SPAWN_DELAY_MS;
let lastTime: number | null = null;
let draggingPointerId: number | null = null;
const pressed = new Set<string>();

// Shield: matching same-hue circles charges it; a full charge banks one
// shield that absorbs the next otherwise-fatal hit instead of ending the
// round. Rewards playing well (matching), not just surviving, and gives the
// widening colour set from activeHueCount somewhere to spend the points it
// makes harder to earn.
const SHIELD_MATCHES_REQUIRED = 6;
const MAX_SHIELDS = 3;
let shields = 0;
let shieldProgress = 0;

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: string;
  size: number;
}
let particles: Particle[] = [];
let shakeTime = 0;

// Double-tap an arrow key within the window to dash: a quick burst of extra
// move speed in that direction. Only the arrow keys trigger it (not the a/d
// aliases) since a dash reads as a deliberate double-press, and doubling on
// a/d would fire constantly for anyone who taps rather than holds.
const DASH_MULTIPLIER = 2.4;
const DASH_DURATION_S = 0.4;
const DOUBLE_TAP_WINDOW_MS = 300;
let dashTime = 0;
let lastArrowPress: { key: "left" | "right" | null; at: number } = { key: null, at: 0 };

// Shifting obstacles cycle hue as they fall, so touching one is a gamble on
// whatever colour it happens to hold at contact --- higher risk than a
// stable obstacle, so a successful match pays out more.
const SHIFT_CHANCE = 0.16;
const SHIFT_INTERVAL_MS = 220;
const SHIFT_MIN_ELAPSED_S = 12; // give the base game a clean stretch first

// Neutral: once score crosses a threshold, one activation is banked that
// makes every colour safe for a few seconds --- an escape valve for the
// widening palette, spendable on your own timing rather than automatic.
const NEUTRAL_SCORE_STEP = 250;
const NEUTRAL_DURATION_S = 4;
let neutralAvailable = false;
let neutralActive = false;
let neutralTimeLeft = 0;
let neutralNextThreshold = NEUTRAL_SCORE_STEP;

function playRiskyMatchSound() {
  beep(1100, 90, "sine", 0.07);
  setTimeout(() => beep(1400, 90, "sine", 0.06), 60);
}
function playNeutralSound() {
  beep(500, 100, "triangle", 0.08);
  setTimeout(() => beep(750, 100, "triangle", 0.08), 80);
  setTimeout(() => beep(1000, 140, "triangle", 0.08), 160);
}

interface Star {
  x: number;
  y: number;
  size: number;
  speed: number;
}
let stars: Star[] = [];

function spawnBurst(x: number, y: number, color: string, count: number) {
  if (prefersReducedMotion) return;
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 60 + Math.random() * 180;
    particles.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 0,
      maxLife: 0.35 + Math.random() * 0.35,
      color,
      size: 2 + Math.random() * 2.5,
    });
  }
}

function resize() {
  const rect = canvas.getBoundingClientRect();
  width = rect.width;
  height = rect.height;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const radius = clamp(width * 0.045, 14, 24);
  if (!player) {
    player = { x: width / 2, y: 0, radius, hue: "a" };
  } else {
    player.radius = radius;
    player.x = clamp(player.x, radius, width - radius);
  }
  player.y = height - radius - 24;
  // Top-right, clear of the player's row: sharing the bottom corner with the
  // swap button let a resize clamp the player right on top of it, muddling
  // which circle was "you" — found by playing at the mobile viewport.
  swapButton = { x: width - 34, y: 34, radius: 20 };
  muteButton = { x: 34, y: 34, radius: 16 };
  // Below the swap button, clear of the player row like the swap button
  // itself --- only interactive (and only drawn) once neutral is available.
  neutralButton = { x: width - 34, y: 130, radius: 16 };

  // A cheap parallax backdrop: regenerated on resize (not per-frame), so it
  // costs nothing during play beyond drawing dots already sized for the
  // current canvas.
  if (!prefersReducedMotion) {
    const count = Math.round((width * height) / 9000);
    stars = Array.from({ length: count }, () => ({
      x: Math.random() * width,
      y: Math.random() * height,
      size: 0.6 + Math.random() * 1.4,
      speed: 12 + Math.random() * 24,
    }));
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function resetGame() {
  obstacles = [];
  state = "playing";
  elapsedSeconds = 0;
  matchedCount = 0;
  score = 0;
  spawnTimer = FIRST_SPAWN_DELAY_MS;
  player.hue = "a";
  player.x = width / 2;
  shields = 0;
  shieldProgress = 0;
  particles = [];
  shakeTime = 0;
  dashTime = 0;
  lastArrowPress = { key: null, at: 0 };
  neutralAvailable = false;
  neutralActive = false;
  neutralTimeLeft = 0;
  neutralNextThreshold = NEUTRAL_SCORE_STEP;
  announcer.textContent = "";
}

function spawnObstacle() {
  const radius = clamp(width * 0.045, 14, 24);
  const active = activeHueCount(elapsedSeconds);
  const hue: Hue = ALL_HUES[Math.floor(Math.random() * active)];
  const shifting = elapsedSeconds >= SHIFT_MIN_ELAPSED_S && Math.random() < SHIFT_CHANCE;
  obstacles.push({
    x: clamp(Math.random() * width, radius, width - radius),
    y: -radius,
    radius,
    hue,
    shifting,
    shiftTimerMs: shifting ? SHIFT_INTERVAL_MS : undefined,
  });
}

function activateNeutral() {
  if (state !== "playing" || !neutralAvailable) return;
  neutralAvailable = false;
  neutralActive = true;
  neutralTimeLeft = NEUTRAL_DURATION_S;
  neutralNextThreshold = score + NEUTRAL_SCORE_STEP;
  playNeutralSound();
  spawnBurst(player.x, player.y, "#ffffff", 24);
}

function checkDashTrigger(key: "left" | "right") {
  if (state !== "playing") return;
  const now = performance.now();
  if (lastArrowPress.key === key && now - lastArrowPress.at < DOUBLE_TAP_WINDOW_MS) {
    dashTime = DASH_DURATION_S;
    playDashSound();
    spawnBurst(player.x, player.y, HUE_COLOR[player.hue], 6);
    lastArrowPress = { key: null, at: 0 }; // consume, so a third tap starts fresh
  } else {
    lastArrowPress = { key, at: now };
  }
}

function pointFromEvent(event: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function withinSwapButton(x: number, y: number): boolean {
  const dx = x - swapButton.x;
  const dy = y - swapButton.y;
  return dx * dx + dy * dy < (swapButton.radius + 12) ** 2;
}

function withinMuteButton(x: number, y: number): boolean {
  const dx = x - muteButton.x;
  const dy = y - muteButton.y;
  return dx * dx + dy * dy < (muteButton.radius + 12) ** 2;
}

function withinNeutralButton(x: number, y: number): boolean {
  const dx = x - neutralButton.x;
  const dy = y - neutralButton.y;
  return dx * dx + dy * dy < (neutralButton.radius + 12) ** 2;
}

canvas.addEventListener("pointerdown", (event) => {
  canvas.focus();
  const { x, y } = pointFromEvent(event);
  if (withinMuteButton(x, y)) {
    toggleSound();
    return;
  }
  if (state === "gameover") {
    resetGame();
    return;
  }
  if (neutralAvailable && withinNeutralButton(x, y)) {
    activateNeutral();
    return;
  }
  if (withinSwapButton(x, y)) {
    player.hue = cycleHue(player.hue, activeHueCount(elapsedSeconds));
    playSwapSound();
    return;
  }
  // Keyed by pointerId, not a shared flag: an incidental second touch (a
  // palm edge, a bracing finger) lifting off must not stop the pointer
  // that's actually dragging --- found by simulating two independent
  // pointer identities and watching the first one's still-held drag go
  // unresponsive the instant the second one released.
  if (draggingPointerId !== null) return;
  draggingPointerId = event.pointerId;
  canvas.setPointerCapture(event.pointerId);
  player.x = clamp(x, player.radius, width - player.radius);
});

canvas.addEventListener("pointermove", (event) => {
  if (event.pointerId !== draggingPointerId) return;
  const { x } = pointFromEvent(event);
  player.x = clamp(x, player.radius, width - player.radius);
});

function endDrag(event: PointerEvent) {
  if (event.pointerId !== draggingPointerId) return;
  draggingPointerId = null;
  if (canvas.hasPointerCapture(event.pointerId)) {
    canvas.releasePointerCapture(event.pointerId);
  }
}
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);

window.addEventListener("keydown", (event) => {
  // Space, the arrow keys, Home, End, PageUp and PageDown are all browser
  // scroll keys and the game has no use for any of them, so all six are
  // suppressed unconditionally here rather than only inside the branches
  // below --- Home/End/PageUp/PageDown scrolled the page during ordinary
  // play the same way ArrowUp/ArrowDown once did, confirmed live at a real
  // short viewport, since none of the four has an in-game effect that would
  // otherwise call preventDefault() on them.
  if (
    event.key === " " ||
    event.key === "Spacebar" ||
    event.key === "ArrowUp" ||
    event.key === "ArrowDown" ||
    event.key === "Home" ||
    event.key === "End" ||
    event.key === "PageUp" ||
    event.key === "PageDown"
  ) {
    event.preventDefault();
  }
  if (event.key === "m" || event.key === "M") {
    toggleSound();
    return;
  }
  if (event.key === "n" || event.key === "N") {
    activateNeutral();
    return;
  }
  if (state === "playing" && ["1", "2", "3", "4"].includes(event.key)) {
    // Direct selection, not just cycling: picks the Nth active hue outright,
    // a faster route to a specific colour once there are more than two to
    // cycle through. A digit beyond the currently active count is a no-op
    // rather than an error, since which digits do anything changes as
    // activeHueCount ramps up mid-round.
    const index = Number(event.key) - 1;
    const active = activeHueCount(elapsedSeconds);
    if (index < active) {
      player.hue = ALL_HUES[index];
      playSwapSound();
    }
    return;
  }
  if (state === "gameover") {
    // A key held down at the moment of a fatal collision --- the likely case,
    // since dying usually happens mid-dodge --- keeps sending repeat keydowns
    // for as long as it stays physically held. Restarting on those wipes the
    // game-over screen before the player ever sees it; only a genuine fresh
    // keydown (a release-and-repress, or a different key) should restart.
    if (event.repeat) return;
    resetGame();
    return;
  }
  if (event.key === "ArrowLeft" || event.key === "a" || event.key === "A") {
    pressed.add("left");
    event.preventDefault();
    if (event.key === "ArrowLeft" && !event.repeat) checkDashTrigger("left");
  } else if (event.key === "ArrowRight" || event.key === "d" || event.key === "D") {
    pressed.add("right");
    event.preventDefault();
    if (event.key === "ArrowRight" && !event.repeat) checkDashTrigger("right");
  } else if (event.key === " " || event.key === "Spacebar") {
    // A toggle, not a hold: the browser's own key auto-repeat would otherwise
    // keep flipping the hue for as long as Space stays physically held, the
    // same repeat-vs-fresh-press distinction already guarded on gameover
    // restart above.
    if (event.repeat) return;
    player.hue = cycleHue(player.hue, activeHueCount(elapsedSeconds));
    playSwapSound();
  }
});

window.addEventListener("keyup", (event) => {
  if (event.key === "ArrowLeft" || event.key === "a" || event.key === "A") pressed.delete("left");
  if (event.key === "ArrowRight" || event.key === "d" || event.key === "D") pressed.delete("right");
});

// A key held down while the tab loses focus never gets its keyup — clear
// held state so the player doesn't drift on refocus. blur alone misses a
// same-window tab switch (the browser window keeps OS focus, so it never
// blurs, but the document does still hide); visibilitychange catches that
// case too.
function releaseHeldInput() {
  pressed.clear();
  draggingPointerId = null;
}
window.addEventListener("blur", releaseHeldInput);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) releaseHeldInput();
});

function gameOver() {
  state = "gameover";
  // A collision mid-drag leaves the pointer still down with no pointerup to
  // clear it --- without this, pointermove keeps sliding the player under
  // the game-over overlay, found by forcing the collision mid-drag and
  // watching playerX keep tracking the pointer after the round had ended.
  draggingPointerId = null;
  announcer.textContent = `Game over. Final score ${score}.`;
  playGameOverSound();
  spawnBurst(player.x, player.y, HUE_COLOR[player.hue], 28);
  shakeTime = 0.3;
}

function update(dt: number) {
  elapsedSeconds += dt;

  for (const star of stars) {
    star.y += star.speed * dt;
    if (star.y > height) star.y = 0;
  }

  if (dashTime > 0) dashTime = Math.max(0, dashTime - dt);

  if (!neutralActive && !neutralAvailable && score >= neutralNextThreshold) {
    neutralAvailable = true;
  }
  if (neutralActive) {
    neutralTimeLeft = Math.max(0, neutralTimeLeft - dt);
    if (neutralTimeLeft === 0) neutralActive = false;
  }

  if (draggingPointerId === null) {
    const dir = (pressed.has("right") ? 1 : 0) - (pressed.has("left") ? 1 : 0);
    const baseSpeed = moveSpeed(elapsedSeconds);
    const speed = dashTime > 0 ? baseSpeed * DASH_MULTIPLIER : baseSpeed;
    player.x = clamp(player.x + dir * speed * dt, player.radius, width - player.radius);
  }

  spawnTimer -= dt * 1000;
  if (spawnTimer <= 0) {
    spawnObstacle();
    spawnTimer = spawnIntervalMs(elapsedSeconds);
  }

  const speed = fallSpeed(elapsedSeconds);
  const survivors: Obstacle[] = [];
  for (const obstacle of obstacles) {
    obstacle.y += speed * dt;

    if (obstacle.shifting && obstacle.shiftTimerMs !== undefined) {
      obstacle.shiftTimerMs -= dt * 1000;
      if (obstacle.shiftTimerMs <= 0) {
        const active = activeHueCount(elapsedSeconds);
        obstacle.hue = ALL_HUES[Math.floor(Math.random() * active)];
        obstacle.shiftTimerMs = SHIFT_INTERVAL_MS;
      }
    }

    const overlapping = circlesOverlap(player, obstacle);
    if (overlapping) {
      const fatal = !neutralActive && isFatalCollision(player, obstacle);
      if (fatal) {
        if (shields > 0) {
          shields -= 1;
          playShieldBreakSound();
          spawnBurst(player.x, player.y, "#f5f5f7", 16);
          shakeTime = Math.max(shakeTime, 0.18);
          continue; // banked shield absorbs the hit; no score, round continues
        }
        gameOver();
        survivors.push(obstacle);
        continue;
      }
      matchedCount += 1;
      score += obstacle.shifting ? 25 : 15;
      if (obstacle.shifting) {
        playRiskyMatchSound();
        spawnBurst(obstacle.x, obstacle.y, "#ffffff", 16);
      } else {
        playMatchSound();
        spawnBurst(obstacle.x, obstacle.y, HUE_COLOR[obstacle.hue], 10);
      }
      shieldProgress += 1;
      if (shieldProgress >= SHIELD_MATCHES_REQUIRED && shields < MAX_SHIELDS) {
        shieldProgress = 0;
        shields += 1;
        playShieldUpSound();
      }
      continue; // safe overlap (same hue, or neutral): absorbed, removed from play
    }
    if (obstacle.y - obstacle.radius <= height) {
      survivors.push(obstacle);
    }
  }
  obstacles = survivors;

  for (const p of particles) {
    p.life += dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vx *= 0.92;
    p.vy *= 0.92;
  }
  particles = particles.filter((p) => p.life < p.maxLife);
  if (shakeTime > 0) shakeTime = Math.max(0, shakeTime - dt);
}

function draw() {
  ctx.save();
  if (shakeTime > 0 && !prefersReducedMotion) {
    const magnitude = shakeTime * 18;
    ctx.translate((Math.random() - 0.5) * magnitude, (Math.random() - 0.5) * magnitude);
  }

  const bg = ctx.createLinearGradient(0, 0, 0, height);
  bg.addColorStop(0, "#1c2140");
  bg.addColorStop(1, "#0d0f1c");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  for (const star of stars) {
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = "#f5f5f7";
    ctx.fillRect(star.x, star.y, star.size, star.size);
  }
  ctx.globalAlpha = 1;

  for (const obstacle of obstacles) {
    ctx.beginPath();
    ctx.shadowColor = HUE_COLOR[obstacle.hue];
    ctx.shadowBlur = 12;
    ctx.fillStyle = HUE_COLOR[obstacle.hue];
    ctx.arc(obstacle.x, obstacle.y, obstacle.radius, 0, Math.PI * 2);
    ctx.fill();
    if (obstacle.shifting) {
      // A fast dashed white ring flags "this one's a gamble" independent of
      // whatever colour it's currently showing --- the colour itself will
      // have changed again by the time a player reacts to it.
      ctx.shadowBlur = 0;
      ctx.beginPath();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.setLineDash([3, 3]);
      ctx.lineDashOffset = prefersReducedMotion ? 0 : elapsedSeconds * -120;
      ctx.arc(obstacle.x, obstacle.y, obstacle.radius + 4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  ctx.shadowBlur = 0;

  for (const p of particles) {
    ctx.globalAlpha = Math.max(0, 1 - p.life / p.maxLife);
    ctx.beginPath();
    ctx.fillStyle = p.color;
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Shield rings: one dashed ring per banked charge, orbiting slowly so a
  // full shield reads as active even when the player isn't moving.
  for (let i = 0; i < shields; i++) {
    ctx.beginPath();
    ctx.strokeStyle = "#f5f5f7";
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 5]);
    ctx.lineDashOffset = prefersReducedMotion ? 0 : elapsedSeconds * 40;
    ctx.arc(player.x, player.y, player.radius + 6 + i * 6, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  if (neutralActive) {
    // A wide white halo, brightest right after activation and fading with
    // the timer, so "any colour is safe right now" is visible at a glance
    // without reading the countdown text.
    ctx.beginPath();
    ctx.fillStyle = `rgba(255, 255, 255, ${0.15 + 0.15 * (neutralTimeLeft / NEUTRAL_DURATION_S)})`;
    ctx.arc(player.x, player.y, player.radius + 14, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.beginPath();
  ctx.shadowColor = neutralActive ? "#ffffff" : HUE_COLOR[player.hue];
  ctx.shadowBlur = neutralActive ? 26 : 18;
  ctx.fillStyle = HUE_COLOR[player.hue];
  ctx.arc(player.x, player.y, player.radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = neutralActive ? 3 : 2;
  ctx.strokeStyle = "#f5f5f7";
  ctx.stroke();

  const pulse = prefersReducedMotion ? 0 : Math.sin(elapsedSeconds * 4) * 2;
  ctx.beginPath();
  ctx.fillStyle = HUE_COLOR[cycleHue(player.hue, activeHueCount(elapsedSeconds))];
  ctx.arc(swapButton.x, swapButton.y, swapButton.radius + pulse, 0, Math.PI * 2);
  ctx.fill();
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = "#f5f5f7";
  ctx.stroke();
  ctx.setLineDash([]);

  // Shield charge progress ring under the swap button: fills up as matches
  // accumulate, so the player can see a shield coming before it lands.
  if (shields < MAX_SHIELDS) {
    const progressFrac = shieldProgress / SHIELD_MATCHES_REQUIRED;
    ctx.beginPath();
    ctx.strokeStyle = "rgba(245, 245, 247, 0.35)";
    ctx.lineWidth = 3;
    ctx.arc(swapButton.x, swapButton.y + 40, 10, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.strokeStyle = "#f5f5f7";
    ctx.lineWidth = 3;
    ctx.arc(swapButton.x, swapButton.y + 40, 10, -Math.PI / 2, -Math.PI / 2 + progressFrac * Math.PI * 2);
    ctx.stroke();
  }

  // Neutral ability icon: only drawn once it's banked, so it doesn't clutter
  // the HUD before there's anything to press. A star reads as "bonus" at a
  // glance; pulses gently while armed so it isn't missed against the busier
  // background this riff added.
  if (neutralAvailable || neutralActive) {
    const starPulse = neutralActive || prefersReducedMotion ? 0 : Math.sin(elapsedSeconds * 5) * 2;
    ctx.beginPath();
    ctx.fillStyle = neutralActive ? "#ffffff" : "#f5f5f7";
    const spikes = 5;
    const outerR = neutralButton.radius - 2 + starPulse;
    const innerR = outerR * 0.45;
    for (let i = 0; i < spikes * 2; i++) {
      const r = i % 2 === 0 ? outerR : innerR;
      const angle = (Math.PI / spikes) * i - Math.PI / 2;
      const px = neutralButton.x + Math.cos(angle) * r;
      const py = neutralButton.y + Math.sin(angle) * r;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
    if (neutralActive) {
      ctx.beginPath();
      ctx.strokeStyle = "#f5f5f7";
      ctx.lineWidth = 2;
      ctx.arc(
        neutralButton.x,
        neutralButton.y,
        neutralButton.radius + 6,
        -Math.PI / 2,
        -Math.PI / 2 + (neutralTimeLeft / NEUTRAL_DURATION_S) * Math.PI * 2,
      );
      ctx.stroke();
    }
  }

  // Mute toggle, drawn as a filled/crossed speaker so its state reads at a
  // glance without a text label competing with the score line beside it.
  ctx.beginPath();
  ctx.fillStyle = "#f5f5f7";
  ctx.moveTo(muteButton.x - 9, muteButton.y - 4);
  ctx.lineTo(muteButton.x - 4, muteButton.y - 4);
  ctx.lineTo(muteButton.x + 3, muteButton.y - 9);
  ctx.lineTo(muteButton.x + 3, muteButton.y + 9);
  ctx.lineTo(muteButton.x - 4, muteButton.y + 4);
  ctx.lineTo(muteButton.x - 9, muteButton.y + 4);
  ctx.closePath();
  ctx.fill();
  if (!soundOn) {
    ctx.strokeStyle = "#f5f5f7";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(muteButton.x - 10, muteButton.y - 10);
    ctx.lineTo(muteButton.x + 12, muteButton.y + 10);
    ctx.stroke();
  }

  ctx.fillStyle = "#f5f5f7";
  ctx.font = "16px system-ui, sans-serif";
  ctx.fillText(`Score: ${score}`, muteButton.x + muteButton.radius + 12, 24);

  // Level is just activeHueCount reframed as a counter that only goes up ---
  // the same escalation, in a shape a player reads as progress rather than a
  // fact about the palette.
  const active = activeHueCount(elapsedSeconds);
  const level = active - 1;
  ctx.font = "12px system-ui, sans-serif";
  ctx.fillText(`Level ${level} · ${active} colours`, muteButton.x + muteButton.radius + 12, 44);

  if (state === "gameover") {
    ctx.fillStyle = "rgba(15, 18, 32, 0.75)";
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#f5f5f7";
    ctx.textAlign = "center";
    ctx.font = "bold 28px system-ui, sans-serif";
    ctx.fillText("Game over", width / 2, height / 2 - 16);
    ctx.font = "18px system-ui, sans-serif";
    ctx.fillText(`Score: ${score}`, width / 2, height / 2 + 16);
    ctx.fillText("↻", width / 2, height / 2 + 56);
    ctx.textAlign = "left";
  }
  ctx.restore();
}

function loop(timestamp: number) {
  if (lastTime === null) lastTime = timestamp;
  const dt = Math.min((timestamp - lastTime) / 1000, MAX_DT);
  lastTime = timestamp;

  if (state === "playing") {
    update(dt);
  }
  draw();
  requestAnimationFrame(loop);
}

resize();
window.addEventListener("resize", resize);
requestAnimationFrame(loop);
