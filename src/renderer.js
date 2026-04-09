import { WIN_W, WIN_H, CELL_SIZE, GRID_W, GRID_H } from './config.js'

// ── Asset loading ─────────────────────────────────────────────────────────────

const ASSETS_DIR = './Graphics/'
const ASSET_NAMES = [
  'apple',
  'body_bottomleft', 'body_bottomright',
  'body_horizontal',
  'body_topleft', 'body_topright',
  'body_vertical',
  'head_down', 'head_left', 'head_right', 'head_up',
  'tail_down', 'tail_left', 'tail_right', 'tail_up',
]
const imgs = {}

export function preloadAssets() {
  return Promise.all(
    ASSET_NAMES.map(name => new Promise(resolve => {
      const img = new Image()
      img.onload  = () => { imgs[name] = img; resolve() }
      img.onerror = () => { console.warn(`Asset missing: ${name}.png`); resolve() }
      img.src = `${ASSETS_DIR}${name}.png`
    }))
  )
}

// ── Background ────────────────────────────────────────────────────────────────

const ARENA_DARK  = '#0d0806'
const ARENA_LIGHT = '#110a07'

function drawBackground(ctx) {
  for (let x = 0; x < GRID_W; x++) {
    for (let y = 0; y < GRID_H; y++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? ARENA_LIGHT : ARENA_DARK
      ctx.fillRect(x * CELL_SIZE, y * CELL_SIZE, CELL_SIZE, CELL_SIZE)
    }
  }
  // Subtle arena grid lines
  ctx.strokeStyle = 'rgba(255,69,0,0.06)'
  ctx.lineWidth = 1
  for (let x = 0; x <= GRID_W; x++) {
    ctx.beginPath(); ctx.moveTo(x * CELL_SIZE, 0); ctx.lineTo(x * CELL_SIZE, WIN_H); ctx.stroke()
  }
  for (let y = 0; y <= GRID_H; y++) {
    ctx.beginPath(); ctx.moveTo(0, y * CELL_SIZE); ctx.lineTo(WIN_W, y * CELL_SIZE); ctx.stroke()
  }
}

// ── Sprite helpers ────────────────────────────────────────────────────────────

function drawSprite(ctx, name, gx, gy) {
  const img = imgs[name]
  if (!img) {
    ctx.fillStyle = '#5a8aff'
    ctx.fillRect(gx * CELL_SIZE + 2, gy * CELL_SIZE + 2, CELL_SIZE - 4, CELL_SIZE - 4)
    return
  }
  ctx.drawImage(img, gx * CELL_SIZE, gy * CELL_SIZE, CELL_SIZE, CELL_SIZE)
}

function hasVec(a, b, dx, dy) {
  return (a.dx === dx && a.dy === dy) || (b.dx === dx && b.dy === dy)
}

function getBodySpriteName(body, i) {
  const [cx, cy] = body[i]
  const [px, py] = body[i - 1]   // toward head
  const [nx, ny] = body[i + 1]   // toward tail

  const toPrev = { dx: px - cx, dy: py - cy }
  const toNext = { dx: nx - cx, dy: ny - cy }

  // Straight
  if (toPrev.dy === 0 && toNext.dy === 0) return 'body_horizontal'
  if (toPrev.dx === 0 && toNext.dx === 0) return 'body_vertical'

  // Corners
  const up    = hasVec(toPrev, toNext,  0, -1)
  const down  = hasVec(toPrev, toNext,  0,  1)
  const left  = hasVec(toPrev, toNext, -1,  0)
  const right = hasVec(toPrev, toNext,  1,  0)

  if (up   && right) return 'body_topright'
  if (up   && left)  return 'body_topleft'
  if (down && right) return 'body_bottomright'
  if (down && left)  return 'body_bottomleft'

  return 'body_horizontal'
}

function getHeadSpriteName(body) {
  if (body.length < 2) return 'head_right'
  const [hx, hy] = body[0]
  const [bx, by] = body[1]
  const dx = bx - hx   // body[1] - body[0], same logic as original Python
  const dy = by - hy
  if (dx ===  1) return 'head_left'
  if (dx === -1) return 'head_right'
  if (dy ===  1) return 'head_up'
  if (dy === -1) return 'head_down'
  return 'head_right'
}

function getTailSpriteName(body) {
  const n = body.length
  const [tx, ty] = body[n - 1]
  const [sx, sy] = body[n - 2]
  const dx = tx - sx
  const dy = ty - sy
  if (dy === -1) return 'tail_up'
  if (dy ===  1) return 'tail_down'
  if (dx === -1) return 'tail_left'
                 return 'tail_right'
}

// ── HUD helpers ───────────────────────────────────────────────────────────────

function drawPill(ctx, x, y, w, h, r) {
  ctx.fillStyle = 'rgba(0,0,0,0.55)'
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, r)
  ctx.fill()
}

// ── Main game frame ───────────────────────────────────────────────────────────

export function drawGame(ctx, snake, food, score, handState) {
  drawBackground(ctx)

  // Food
  drawSprite(ctx, 'apple', food[0], food[1])

  // Snake — draw tail→body→head so head appears on top
  const body = snake.body
  const n    = body.length

  if (n >= 2) {
    drawSprite(ctx, getTailSpriteName(body), body[n - 1][0], body[n - 1][1])
    for (let i = n - 2; i >= 1; i--) {
      drawSprite(ctx, getBodySpriteName(body, i), body[i][0], body[i][1])
    }
  }
  drawSprite(ctx, getHeadSpriteName(body), body[0][0], body[0][1])

  // Score pill (top-left)
  const scoreText = `Score: ${score}`
  ctx.font = 'bold 15px "Rajdhani", monospace'
  const scoreW = ctx.measureText(scoreText).width + 18
  ctx.fillStyle = 'rgba(0,0,0,0.72)'
  ctx.beginPath(); ctx.roundRect(6, 6, scoreW, 26, 3); ctx.fill()
  ctx.strokeStyle = 'rgba(255,107,0,0.6)'; ctx.lineWidth = 1
  ctx.beginPath(); ctx.roundRect(6, 6, scoreW, 26, 3); ctx.stroke()
  ctx.fillStyle    = '#ffcc00'
  ctx.textAlign    = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(scoreText, 15, 19)

  // Hand-state pill (top-right)
  const stateColors = { none: '#665544', fist: '#cc8844', pointing: '#ff6b00' }
  const stateLabels = { none: 'no hand', fist: 'fist ✊', pointing: 'pointing ☝' }
  const stateText   = stateLabels[handState] ?? handState
  const stateCol    = stateColors[handState] ?? '#665544'
  ctx.font = 'bold 13px "Rajdhani", monospace'
  const stateW = ctx.measureText(stateText).width + 18
  ctx.fillStyle = 'rgba(0,0,0,0.72)'
  ctx.beginPath(); ctx.roundRect(WIN_W - stateW - 6, 6, stateW, 26, 3); ctx.fill()
  ctx.strokeStyle = 'rgba(255,107,0,0.4)'; ctx.lineWidth = 1
  ctx.beginPath(); ctx.roundRect(WIN_W - stateW - 6, 6, stateW, 26, 3); ctx.stroke()
  ctx.fillStyle    = stateCol
  ctx.textAlign    = 'right'
  ctx.textBaseline = 'middle'
  ctx.fillText(stateText, WIN_W - 15, 19)

  // Reset
  ctx.textAlign    = 'left'
  ctx.textBaseline = 'alphabetic'
}

// ── Game-over canvas overlay ──────────────────────────────────────────────────

export function drawGameOverLayer(ctx, snake) {
  const [hx, hy] = snake.body[0]
  const wallDeath = hx < 0 || hx >= GRID_W || hy < 0 || hy >= GRID_H

  // Subtle dark tint to frame the death scene
  ctx.fillStyle = 'rgba(0,0,0,0.32)'
  ctx.fillRect(0, 0, WIN_W, WIN_H)

  // Clamp to grid for drawing (head may be 1 cell outside on wall death)
  const gx = Math.max(0, Math.min(GRID_W - 1, hx))
  const gy = Math.max(0, Math.min(GRID_H - 1, hy))
  const cx = gx * CELL_SIZE + CELL_SIZE / 2
  const cy = gy * CELL_SIZE + CELL_SIZE / 2

  // Red radial glow around the death cell
  const grd = ctx.createRadialGradient(cx, cy, 2, cx, cy, CELL_SIZE * 2)
  grd.addColorStop(0, 'rgba(255,0,0,0.75)')
  grd.addColorStop(1, 'rgba(255,0,0,0)')
  ctx.fillStyle = grd
  ctx.fillRect(
    (gx - 1) * CELL_SIZE, (gy - 1) * CELL_SIZE,
    CELL_SIZE * 3,        CELL_SIZE * 3
  )

  // Red X on the death cell
  ctx.strokeStyle = 'rgba(255,40,40,0.95)'
  ctx.lineWidth   = 3
  ctx.lineCap     = 'round'
  ctx.beginPath()
  ctx.moveTo(gx * CELL_SIZE + 6,             gy * CELL_SIZE + 6)
  ctx.lineTo(gx * CELL_SIZE + CELL_SIZE - 6, gy * CELL_SIZE + CELL_SIZE - 6)
  ctx.moveTo(gx * CELL_SIZE + CELL_SIZE - 6, gy * CELL_SIZE + 6)
  ctx.lineTo(gx * CELL_SIZE + 6,             gy * CELL_SIZE + CELL_SIZE - 6)
  ctx.stroke()

  // For self-collision: also highlight the body segment that was hit
  if (!wallDeath) {
    const hit = snake.body.slice(1).find(([x, y]) => x === hx && y === hy)
    if (hit) {
      const bx = hit[0] * CELL_SIZE + CELL_SIZE / 2
      const by = hit[1] * CELL_SIZE + CELL_SIZE / 2
      const grd2 = ctx.createRadialGradient(bx, by, 2, bx, by, CELL_SIZE * 1.4)
      grd2.addColorStop(0, 'rgba(255,200,0,0.65)')
      grd2.addColorStop(1, 'rgba(255,200,0,0)')
      ctx.fillStyle = grd2
      ctx.fillRect(
        hit[0] * CELL_SIZE - CELL_SIZE / 2, hit[1] * CELL_SIZE - CELL_SIZE / 2,
        CELL_SIZE * 2,                       CELL_SIZE * 2
      )
    }
  }
}
