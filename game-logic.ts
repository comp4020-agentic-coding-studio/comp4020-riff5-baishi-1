// Pure game rules, kept free of the DOM/canvas so they're testable in
// isolation (spec/crit-5.test.ts) and reusable from main.ts's render loop.

export type Hue = "a" | "b" | "c" | "d" | "e" | "f" | "g" | "h" | "i" | "j";

// The full palette, in ramp-in order. Only the first `activeHueCount(t)`
// of these are in play at any moment --- see below. The first four (a-d) are
// a CVD-simulation-checked set; e-j widen the game to 10 colours for a real
// late-round memory/attention test, at the cost of that same guarantee ---
// ten mutually distinguishable hues under every form of colour blindness
// isn't achievable by hue alone, so main.ts's digit-key selection (1-9, 0)
// is the accessible fallback once the palette gets that wide.
export const ALL_HUES: readonly Hue[] = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];

export interface Circle {
  x: number;
  y: number;
  radius: number;
}

export interface Player extends Circle {
  hue: Hue;
}

export interface Obstacle extends Circle {
  hue: Hue;
  // A shifting obstacle cycles its own hue while it falls (main.ts drives the
  // timer); isFatalCollision only ever reads whatever hue it holds at the
  // moment of overlap, so the risk is entirely in the timing, not in any
  // extra rule here.
  shifting?: boolean;
  shiftTimerMs?: number;
  // Per-obstacle multiplier on fallSpeed(t), fixed at spawn --- without it
  // every obstacle on screen moves in lockstep, which reads as one wave
  // rather than a field of independent threats. isFatalCollision doesn't
  // care how a circle got to where it is, only whether it's there.
  speedMult?: number;
  // Sideways drift in px/s, bounced off the play-area edges by main.ts ---
  // gives obstacles independent paths instead of straight vertical lines, so
  // dodging one doesn't just mean "pick a lane and hold it."
  driftVx?: number;
}

export function circlesOverlap(a: Circle, b: Circle): boolean {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const r = a.radius + b.radius;
  return dx * dx + dy * dy < r * r;
}

// The one rule under test: touching a same-hue obstacle is safe (it matches
// the player's current colour and passes through); touching a different-hue
// obstacle ends the round. No overlap is always safe, regardless of hue.
export function isFatalCollision(player: Player, obstacle: Obstacle): boolean {
  return circlesOverlap(player, obstacle) && player.hue !== obstacle.hue;
}

export function otherHue(hue: Hue): Hue {
  return hue === "a" ? "b" : "a";
}

// How many hues are live right now. Starts at the original two and adds one
// more every 25s, capped at the full palette --- the harder version of the
// same escalation fallSpeed/spawnIntervalMs already do: early seconds stay
// forgiving, but by the time a round has run a while, tracking your own
// colour against a widening set is the actual challenge, not just speed.
export function activeHueCount(elapsedSeconds: number): number {
  return Math.min(2 + Math.floor(elapsedSeconds / 25), ALL_HUES.length);
}

// Advance to the next hue among the ones currently in play, wrapping --- the
// N-colour replacement for otherHue's binary flip. If the player's current
// hue has fallen outside the active set (can't happen in practice since the
// set only grows) this still returns a valid active hue rather than throwing.
export function cycleHue(hue: Hue, activeCount: number): Hue {
  const active = ALL_HUES.slice(0, activeCount);
  const index = active.indexOf(hue);
  return active[(index + 1) % active.length] ?? active[0];
}

// Obstacles fall faster and spawn more often the longer a round runs, so the
// opening seconds are forgiving and the difficulty caps out fast enough that
// the five-minute mark is a sustained skill test, not a slow ramp.
export function fallSpeed(elapsedSeconds: number): number {
  return 160 + Math.min(elapsedSeconds * 8, 260);
}

export function spawnIntervalMs(elapsedSeconds: number): number {
  return Math.max(1100 - elapsedSeconds * 22, 380);
}

// The player's own sideways speed ramps too, on the same curve shape as
// fallSpeed --- without this, a later round's faster, wider-palette
// obstacles would out-pace a dodge speed that never changed, and the game
// would get harder by taking control away rather than by demanding more
// skill.
export function moveSpeed(elapsedSeconds: number): number {
  return 340 + Math.min(elapsedSeconds * 6, 200);
}
