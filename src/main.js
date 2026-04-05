/**
 * CV Snake — main entry point
 * ============================
 * State machine:  name ↔ menu ↔ game (playing | over) ↔ leaderboard
 *
 * Hand tracking pipeline:
 *   1. Grab webcam frame into a hidden canvas and flip it horizontally
 *      (mirror view so pointing YOUR right moves the snake right).
 *   2. Pass the flipped canvas to HandTracker → direction string | null.
 *   3. Render the same flipped frame + skeleton onto the PiP canvas.
 */

import { MOVE_DELAY, CELL_SIZE }        from './config.js'
import { Snake, spawnFood }            from './snake.js'
import { HandTracker }                 from './hand_tracker.js'
import { drawGame, drawGameOverLayer, preloadAssets } from './renderer.js'
import { isConfigured, submitBestScore, getTopScores, checkNameExists } from './leaderboard.js'

// ── Arena Sound Engine ────────────────────────────────────────────────────────
let audioCtx = null
function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)()
  return audioCtx
}
function playTone(freq, dur, type = 'square', vol = 0.12) {
  try {
    const ctx = getAudioCtx()
    const osc = ctx.createOscillator()
    const g   = ctx.createGain()
    osc.connect(g); g.connect(ctx.destination)
    osc.type = type
    osc.frequency.setValueAtTime(freq, ctx.currentTime)
    g.gain.setValueAtTime(vol, ctx.currentTime)
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur)
    osc.start(); osc.stop(ctx.currentTime + dur)
  } catch {}
}
function sfxEat()  { playTone(520, 0.05, 'square', 0.1); setTimeout(() => playTone(780, 0.08, 'square', 0.09), 45) }
function sfxDeath(){ playTone(220, 0.1, 'sawtooth', 0.18); setTimeout(() => playTone(160, 0.12, 'sawtooth', 0.15), 90); setTimeout(() => playTone(100, 0.22, 'sawtooth', 0.12), 200) }
function sfxClick(){ playTone(400, 0.04, 'square', 0.07) }

// ── Screen shake ─────────────────────────────────────────────────────────────
function shakeEl(el, ms = 380) {
  el.classList.remove('shake')
  requestAnimationFrame(() => {
    el.classList.add('shake')
    setTimeout(() => el.classList.remove('shake'), ms)
  })
}

// ── Tiny promise sleep ────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── Score popup & sparks ─────────────────────────────────────────────────────
function spawnScorePopup(gridX, gridY, text) {
  const container = $('game-container')
  const popup = document.createElement('div')
  popup.className = 'score-popup'
  popup.textContent = text
  popup.style.left = (gridX * CELL_SIZE + CELL_SIZE / 2 - 20) + 'px'
  popup.style.top  = (gridY * CELL_SIZE - 10) + 'px'
  container.appendChild(popup)
  popup.addEventListener('animationend', () => popup.remove())
}

function spawnSparks(gridX, gridY, count = 6) {
  const container = $('game-container')
  for (let i = 0; i < count; i++) {
    const s = document.createElement('div')
    s.className = 'spark'
    const ox = (Math.random() - 0.5) * CELL_SIZE
    const oy = (Math.random() - 0.5) * CELL_SIZE
    s.style.left  = (gridX * CELL_SIZE + CELL_SIZE / 2 + ox) + 'px'
    s.style.top   = (gridY * CELL_SIZE + CELL_SIZE / 2 + oy) + 'px'
    s.style.animationDelay = (Math.random() * 0.12) + 's'
    container.appendChild(s)
    s.addEventListener('animationend', () => s.remove())
  }
}

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id)

const screens = {
  name:        $('screen-name'),
  menu:        $('screen-menu'),
  game:        $('screen-game'),
  leaderboard: $('screen-leaderboard'),
  tutorial:    $('screen-tutorial'),
}

const gameCanvas   = $('game-canvas')
const camPip       = $('cam-pip')
const camVideo     = $('cam-video')
const gameCtx      = gameCanvas.getContext('2d')
const camCtx       = camPip.getContext('2d')
const gameDirArrow = $('game-dir-arrow')
const gameDirCtx   = gameDirArrow.getContext('2d')
const bgMusic      = $('bg-music')

// Hidden flip canvas — same size as webcam input used for MediaPipe
const flipCanvas   = document.createElement('canvas')
const flipCtx      = flipCanvas.getContext('2d')

// ── App state ─────────────────────────────────────────────────────────────────
let playerName    = ''
let currentScreen = ''
let gameState     = 'idle'  // 'playing' | 'over'
let cameraReady   = false
let rafId         = null
let musicMuted    = false

// ── Music control ─────────────────────────────────────────────────────────────
function startMusic() {
  bgMusic.currentTime = 0
  bgMusic.play().catch(() => {})
}
function stopMusic() {
  bgMusic.pause()
  bgMusic.currentTime = 0
}

// ── Game objects ──────────────────────────────────────────────────────────────
const tracker = new HandTracker()
const snake   = new Snake()
let food      = spawnFood(snake.body)
let score     = 0
let lastStep  = 0

// ── Tutorial ────────────────────────────────────────────────────────────────────────────
const TUTORIAL_STEPS = [
  { dir: 'UP',    label: 'UP'    },
  { dir: 'RIGHT', label: 'RIGHT' },
  { dir: 'DOWN',  label: 'DOWN'  },
  { dir: 'LEFT',  label: 'LEFT'  },
]
const TUT_HOLD_MS = 3000

let tutStep      = 0
let tutDone      = [false, false, false, false]
let tutHoldStart = null
let tutRafId     = null

const tutCamCanvas = $('tut-cam')
const tutCamCtx    = tutCamCanvas.getContext('2d')
const tutArrowEl   = $('tut-arrow')
const tutArrowCtx  = tutArrowEl.getContext('2d')

// ── Init MediaPipe in background ─────────────────────────────────────────────
preloadAssets()

tracker.init()
  .then(() => {
    $('tracker-status').textContent = 'Hand tracker ready ✓'
    $('tracker-status').classList.add('ready')
  })
  .catch(() => {
    $('tracker-status').textContent = 'Hand tracker unavailable — use arrow keys'
  })

// ── Screen management ─────────────────────────────────────────────────────────
function showScreen(name) {
  Object.entries(screens).forEach(([k, el]) => {
    el.classList.toggle('hidden', k !== name)
  })
  currentScreen = name
}

function showOverlay(id)  { $(id).classList.remove('hidden') }
function hideOverlay(id)  { $(id).classList.add('hidden') }

// ── Camera ────────────────────────────────────────────────────────────────────
async function initCamera() {
  if (cameraReady) return
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: 640, height: 480 },
    })
    camVideo.srcObject = stream
    await new Promise(res => { camVideo.onloadedmetadata = res })
    flipCanvas.width  = camVideo.videoWidth  || 640
    flipCanvas.height = camVideo.videoHeight || 480
    cameraReady = true
  } catch {
    // Camera denied or unavailable — keyboard-only mode
    cameraReady = false
  }
}

/** Draw flipped video frame onto flipCanvas and return it for MediaPipe. */
function updateFlipCanvas() {
  if (!cameraReady || camVideo.readyState < 2) return
  flipCtx.setTransform(-1, 0, 0, 1, flipCanvas.width, 0)
  flipCtx.drawImage(camVideo, 0, 0)
  flipCtx.resetTransform()
}

/** Draw annotated webcam feed (flipped frame + skeleton) into the side panel canvas. */
function drawCamPip() {
  if (!cameraReady || camVideo.readyState < 2) {
    camCtx.fillStyle = '#0a0a0a'
    camCtx.fillRect(0, 0, camPip.width, camPip.height)
    camCtx.fillStyle = '#333'
    camCtx.font      = '11px monospace'
    camCtx.textAlign = 'center'
    camCtx.textBaseline = 'middle'
    camCtx.fillText('no camera', camPip.width / 2, camPip.height / 2)
    camCtx.textBaseline = 'alphabetic'
    camCtx.textAlign    = 'left'
    return
  }
  camCtx.drawImage(flipCanvas, 0, 0, camPip.width, camPip.height)
  tracker.drawLandmarks(camCtx, tracker.lastLandmarks, camPip.width, camPip.height)

  // Update state badge below camera
  const badge = $('cam-state-badge')
  const labels = { none: 'no hand', fist: 'fist ✊', pointing: 'pointing ☝' }
  badge.textContent = labels[tracker.handState] ?? tracker.handState
  badge.className   = `cam-badge ${tracker.handState}`
}

// ── In-game leaderboard panel ─────────────────────────────────────────────────
async function refreshGameLeaderboard() {
  const list = $('game-lb-list')
  if (!isConfigured()) {
    list.innerHTML = '<li class="glb-placeholder">—</li>'
    return
  }
  try {
    const rows = await getTopScores(10)
    list.innerHTML = ''
    if (rows.length === 0) {
      list.innerHTML = '<li class="glb-placeholder">No scores yet</li>'
      return
    }
    rows.forEach((row, i) => {
      const li = document.createElement('li')
      if (row.player_name === playerName) li.classList.add('glb-me')
      li.innerHTML =
        `<span class="glb-rank">${i + 1}</span>` +
        `<span class="glb-name">${escapeHtml(row.player_name)}</span>` +
        `<span class="glb-score">${row.score}</span>`
      list.appendChild(li)
    })
  } catch {
    list.innerHTML = '<li class="glb-placeholder">unavailable</li>'
  }
}

// ── Game helpers ──────────────────────────────────────────────────────────────
function resetGame() {
  snake.reset()
  food      = spawnFood(snake.body)
  score     = 0
  lastStep  = 0
  gameState = 'playing'
  hideOverlay('overlay-gameover')
  $('submit-status').textContent = ''
  $('submit-status').className   = 'submit-status'
  refreshGameLeaderboard()
}

async function handleGameOver() {
  gameState = 'over'
  drawGameOverLayer(gameCtx, score)
  $('final-score-text').textContent = `Score: ${score}`
  showOverlay('overlay-gameover')

  if (!isConfigured()) return

  const status = $('submit-status')
  status.textContent = 'Saving…'
  status.className   = 'submit-status'

  try {
    const result = await submitBestScore(playerName, score)
    if (result.submitted) {
      status.textContent = result.previousBest === null
        ? 'Score saved! ✓'
        : `New best! ✓  (was ${result.previousBest})`
      status.classList.add('success')
      refreshGameLeaderboard()
    } else {
      status.textContent = `Best is still ${result.currentBest} — keep going!`
      status.classList.add('muted')
    }
  } catch (err) {
    status.textContent = `Could not save: ${err.message}`
    status.classList.add('error')
  }
}

// ── Game loop ─────────────────────────────────────────────────────────────────
function gameLoop(ts) {
  if (gameState !== 'playing') return

  // Process webcam frame
  updateFlipCanvas()
  const { direction } = tracker.process(flipCanvas, ts)
  if (direction) snake.setDirection(direction)

  // Tick
  if (ts - lastStep >= MOVE_DELAY) {
    snake.step()
    lastStep = ts
    if (snake.eat(food)) {
      const oldFX = food[0], oldFY = food[1]
      score += 10
      food = spawnFood(snake.body)
      sfxEat()
      shakeEl($('game-container'), 220)
      spawnScorePopup(oldFX, oldFY, '+10')
      spawnSparks(oldFX, oldFY, 7)
    }
    if (snake.isDead()) {
      drawGame(gameCtx, snake, food, score, tracker.handState)
      drawCamPip()
      drawDirectionArrow(gameDirCtx, gameDirArrow.width, gameDirArrow.height, direction)
      sfxDeath()
      shakeEl($('game-layout'), 500)
      handleGameOver()   // async — intentionally not awaited so loop exits fast
      return
    }
  }

  // Render
  drawGame(gameCtx, snake, food, score, tracker.handState)
  drawCamPip()
  drawDirectionArrow(gameDirCtx, gameDirArrow.width, gameDirArrow.height, direction)

  rafId = requestAnimationFrame(gameLoop)
}

function startGameLoop() {
  if (rafId) cancelAnimationFrame(rafId)
  rafId = requestAnimationFrame(gameLoop)
}

// ── Tutorial helpers ────────────────────────────────────────────────────────────
function drawTutCam() {
  if (!cameraReady || camVideo.readyState < 2) {
    tutCamCtx.fillStyle = '#0a0a0a'
    tutCamCtx.fillRect(0, 0, tutCamCanvas.width, tutCamCanvas.height)
    tutCamCtx.fillStyle = '#333'
    tutCamCtx.font      = '11px monospace'
    tutCamCtx.textAlign = 'center'
    tutCamCtx.textBaseline = 'middle'
    tutCamCtx.fillText('no camera', tutCamCanvas.width / 2, tutCamCanvas.height / 2)
    tutCamCtx.textBaseline = 'alphabetic'
    tutCamCtx.textAlign    = 'left'
    return
  }
  tutCamCtx.drawImage(flipCanvas, 0, 0, tutCamCanvas.width, tutCamCanvas.height)
  tracker.drawLandmarks(tutCamCtx, tracker.lastLandmarks, tutCamCanvas.width, tutCamCanvas.height)
}

function drawDirectionArrow(ctx, w, h, direction) {
  ctx.clearRect(0, 0, w, h)
  const cx = w / 2, cy = h / 2
  const r  = Math.min(w, h) / 2 - 4

  // Background circle
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fillStyle   = '#0f0f0f'
  ctx.fill()
  ctx.strokeStyle = direction ? '#ff6b00' : '#2a2a2a'
  ctx.lineWidth   = 2.5
  ctx.stroke()

  if (!direction) {
    ctx.fillStyle      = '#333'
    ctx.font           = `${Math.round(r * 0.55)}px monospace`
    ctx.textAlign      = 'center'
    ctx.textBaseline   = 'middle'
    ctx.fillText('?', cx, cy)
    ctx.textBaseline   = 'alphabetic'
    ctx.textAlign      = 'left'
    return
  }

  const angles = { RIGHT: 0, UP: -Math.PI / 2, LEFT: Math.PI, DOWN: Math.PI / 2 }
  const angle  = angles[direction] ?? 0
  const len    = r * 0.62
  const tipX   = cx + Math.cos(angle) * len
  const tipY   = cy + Math.sin(angle) * len
  const tailX  = cx - Math.cos(angle) * len * 0.45
  const tailY  = cy - Math.sin(angle) * len * 0.45

  ctx.strokeStyle = '#ff6b00'
  ctx.lineWidth   = 5
  ctx.lineCap     = 'round'
  ctx.beginPath()
  ctx.moveTo(tailX, tailY)
  ctx.lineTo(tipX, tipY)
  ctx.stroke()

  const hLen = r * 0.28
  const hAng = Math.PI / 5
  ctx.beginPath()
  ctx.moveTo(tipX, tipY)
  ctx.lineTo(tipX - hLen * Math.cos(angle - hAng), tipY - hLen * Math.sin(angle - hAng))
  ctx.moveTo(tipX, tipY)
  ctx.lineTo(tipX - hLen * Math.cos(angle + hAng), tipY - hLen * Math.sin(angle + hAng))
  ctx.stroke()
  ctx.lineCap = 'butt'
}

function updateTutProgress(frac) {
  $('tut-prog-fill').style.width      = (frac * 100) + '%'
  $('tut-prog-fill').style.background = frac > 0 ? '#22c55e' : 'var(--fire-1)'
}

function updateTutInstruction() {
  if (tutStep >= TUTORIAL_STEPS.length) return
  const step = TUTORIAL_STEPS[tutStep]
  $('tut-step-label').innerHTML  = `Challenge ${tutStep + 1} of ${TUTORIAL_STEPS.length} — Point your finger <strong>${step.label}</strong>`
  $('tut-prog-label').textContent = 'Hold for 3 seconds…'
}

function completeTutStep() {
  tutDone[tutStep] = true
  $(`tut-icon-${tutStep}`).textContent = '✓'
  $(`tut-card-${tutStep}`).classList.remove('tut-active')
  $(`tut-card-${tutStep}`).classList.add('tut-done')
  tutStep++
  tutHoldStart = null
  updateTutProgress(0)
  if (tutStep < TUTORIAL_STEPS.length) {
    $(`tut-card-${tutStep}`).classList.add('tut-active')
    updateTutInstruction()
  } else {
  $('tut-step-label').textContent  = 'All challenges complete! You are ready to DOMINATE!'
    $('tut-prog-label').textContent  = ''
    $('btn-tut-continue').disabled   = false
  }
}

function tutorialLoop(ts) {
  updateFlipCanvas()

  let direction = null
  if (cameraReady && tracker.isReady) {
    const result = tracker.process(flipCanvas, ts)
    direction    = result.direction
  }

  drawTutCam()
  drawDirectionArrow(tutArrowCtx, tutArrowEl.width, tutArrowEl.height, direction)

  // Direction label
  const dirLabels = {
    UP: 'pointing UP ↑', DOWN: 'pointing DOWN ↓',
    LEFT: 'pointing LEFT ←', RIGHT: 'pointing RIGHT →',
  }
  $('tut-dir-label').textContent = direction
    ? dirLabels[direction]
    : (tracker.handState === 'fist' ? 'fist ✊' : 'no hand')

  // Progress logic
  if (tutStep < TUTORIAL_STEPS.length) {
    const needed = TUTORIAL_STEPS[tutStep].dir
    if (direction === needed) {
      if (tutHoldStart === null) tutHoldStart = ts
      const progress = Math.min(1, (ts - tutHoldStart) / TUT_HOLD_MS)
      updateTutProgress(progress)
      if (progress >= 1) completeTutStep()
    } else {
      tutHoldStart = null
      updateTutProgress(0)
    }
  }

  tutRafId = requestAnimationFrame(tutorialLoop)
}

function stopTutorial() {
  if (tutRafId) {
    cancelAnimationFrame(tutRafId)
    tutRafId = null
  }
}

function showTutorial() {
  tutStep      = 0
  tutDone      = [false, false, false, false]
  tutHoldStart = null
  $('btn-tut-continue').disabled = true
  updateTutProgress(0)
  TUTORIAL_STEPS.forEach((_, i) => {
    $(`tut-card-${i}`).classList.remove('tut-active', 'tut-done')
    $(`tut-icon-${i}`).textContent = '○'
  })
  $('tut-card-0').classList.add('tut-active')
  updateTutInstruction()
  $('tut-dir-label').textContent = 'No hand detected'
  showScreen('tutorial')
  if (tutRafId) cancelAnimationFrame(tutRafId)
  tutRafId = requestAnimationFrame(tutorialLoop)
  initCamera()
}

// ── Countdown sound ───────────────────────────────────────────────────────────
function sfxCountdownHit(isGo = false) {
  try {
    const ctx = getAudioCtx()
    const now = ctx.currentTime

    // Sub-bass impact kick
    const o1 = ctx.createOscillator(), g1 = ctx.createGain()
    o1.connect(g1); g1.connect(ctx.destination)
    o1.type = 'sine'
    o1.frequency.setValueAtTime(isGo ? 110 : 82, now)
    o1.frequency.exponentialRampToValueAtTime(18, now + 0.55)
    g1.gain.setValueAtTime(isGo ? 0.72 : 0.52, now)
    g1.gain.exponentialRampToValueAtTime(0.001, now + 0.55)
    o1.start(now); o1.stop(now + 0.55)

    // Mid body crunch
    const o2 = ctx.createOscillator(), g2 = ctx.createGain()
    o2.connect(g2); g2.connect(ctx.destination)
    o2.type = 'sawtooth'
    o2.frequency.setValueAtTime(isGo ? 230 : 165, now)
    o2.frequency.exponentialRampToValueAtTime(28, now + 0.38)
    g2.gain.setValueAtTime(0.38, now)
    g2.gain.exponentialRampToValueAtTime(0.001, now + 0.38)
    o2.start(now); o2.stop(now + 0.38)

    if (isGo) {
      // High crack
      const o3 = ctx.createOscillator(), g3 = ctx.createGain()
      o3.connect(g3); g3.connect(ctx.destination)
      o3.type = 'square'
      o3.frequency.setValueAtTime(940, now)
      o3.frequency.exponentialRampToValueAtTime(55, now + 0.28)
      g3.gain.setValueAtTime(0.22, now)
      g3.gain.exponentialRampToValueAtTime(0.001, now + 0.28)
      o3.start(now); o3.stop(now + 0.28)

      // Rising arena siren
      const o4 = ctx.createOscillator(), g4 = ctx.createGain()
      o4.connect(g4); g4.connect(ctx.destination)
      o4.type = 'sawtooth'
      o4.frequency.setValueAtTime(290, now)
      o4.frequency.exponentialRampToValueAtTime(1500, now + 0.48)
      g4.gain.setValueAtTime(0.18, now)
      g4.gain.exponentialRampToValueAtTime(0.001, now + 0.48)
      o4.start(now); o4.stop(now + 0.48)
    }
  } catch {}
}

// ── Countdown particle system ─────────────────────────────────────────────────
let _cdParticles  = []
let _cdPRafId     = null

function _cdLaunchParticles(canvas, isGo) {
  const cx = canvas.width  / 2
  const cy = canvas.height / 2
  const count = isGo ? 110 : 60
  const palette = ['#ff0000', '#ff3300', '#ff4500', '#ff6b00', '#ff9900', '#ffcc00', '#ffffff']

  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2
    const speed = isGo
      ? (110 + Math.random() * 300)
      : (65  + Math.random() * 195)
    const sz    = isGo ? (3 + Math.random() * 9) : (2 + Math.random() * 6)
    const life  = 0.65 + Math.random() * 0.85
    _cdParticles.push({
      x:       cx + (Math.random() - 0.5) * 90,
      y:       cy + (Math.random() - 0.5) * 90,
      vx:      Math.cos(angle) * speed,
      vy:      Math.sin(angle) * speed - (isGo ? 90 : 50),   // bias upward
      life,
      maxLife: life,
      size:    sz,
      color:   palette[Math.floor(Math.random() * palette.length)],
      grav:    isGo ? 210 : 148,
    })
  }
}

function _cdStartParticleLoop(ctx, canvas) {
  let last = null
  function tick(ts) {
    if (!last) last = ts
    const dt = Math.min((ts - last) / 1000, 0.05)
    last = ts

    // Clear canvas each frame so game board shows through
    ctx.clearRect(0, 0, canvas.width, canvas.height)

    for (let i = _cdParticles.length - 1; i >= 0; i--) {
      const p = _cdParticles[i]
      p.life -= dt
      if (p.life <= 0) { _cdParticles.splice(i, 1); continue }
      p.x  += p.vx * dt
      p.y  += p.vy * dt
      p.vy += p.grav * dt
      p.vx *= 0.965
      const alpha = Math.pow(p.life / p.maxLife, 1.4)
      ctx.save()
      ctx.globalAlpha  = alpha
      ctx.shadowColor  = p.color
      ctx.shadowBlur   = p.size * 4.5
      ctx.fillStyle    = p.color
      ctx.beginPath()
      ctx.arc(p.x, p.y, p.size * alpha, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
    }

    if (_cdParticles.length > 0) {
      _cdPRafId = requestAnimationFrame(tick)
    } else {
      _cdPRafId = null
      ctx.clearRect(0, 0, canvas.width, canvas.height)
    }
  }
  if (_cdPRafId) cancelAnimationFrame(_cdPRafId)
  _cdPRafId = requestAnimationFrame(tick)
}

// ── Main countdown ────────────────────────────────────────────────────────────
async function runCountdown() {
  const overlay = $('countdown-overlay')
  const numEl   = $('countdown-number')
  const flashEl = $('countdown-flash')
  const canvas  = $('countdown-canvas')
  const ctx     = canvas.getContext('2d')

  canvas.width  = window.innerWidth
  canvas.height = window.innerHeight
  _cdParticles  = []

  // Draw the initial game frame so the board + snake are visible through the transparent overlay
  drawGame(gameCtx, snake, food, score, tracker.handState)

  overlay.classList.remove('hidden')
  // Ensure music is playing from the first beat of the countdown
  bgMusic.play().catch(() => {})

  // Per-step config: text, text colour, glow colour, flash colour
  const steps = [
    { label: '3',  color: '#ff3322', glow: '#cc0000', flash: '#ffffff' },
    { label: '2',  color: '#ff6633', glow: '#ff3300', flash: '#ffffff' },
    { label: '1',  color: '#ffaa44', glow: '#ff7700', flash: '#ffcc88' },
    { label: 'GO', color: '#ffee55', glow: '#ffcc00', flash: '#ffee44' },
  ]

  for (let i = 0; i < steps.length; i++) {
    const { label, color, glow, flash } = steps[i]
    const isGo = label === 'GO'

    // Style number
    numEl.textContent  = label
    numEl.style.color  = color
    numEl.style.filter = `drop-shadow(0 0 28px ${glow}) drop-shadow(0 0 60px ${glow}80)`

    // Trigger slam animation (force reflow first to restart if needed)
    numEl.classList.remove('cd-slam-in', 'cd-explode-out', 'cd-go-slam', 'cd-go-explode')
    void numEl.offsetWidth
    numEl.classList.add(isGo ? 'cd-go-slam' : 'cd-slam-in')

    // Audio boom
    sfxCountdownHit(isGo)

    // Screen shake — shake both the overlay content and the arena behind it
    shakeEl(overlay,   isGo ? 750 : 420)
    shakeEl($('app'),  isGo ? 750 : 420)

    // White/gold flash
    flashEl.style.background = flash
    flashEl.classList.remove('cd-flash-anim')
    void flashEl.offsetWidth
    flashEl.classList.add('cd-flash-anim')

    // Particle burst
    _cdLaunchParticles(canvas, isGo)
    _cdStartParticleLoop(ctx, canvas)

    // Hold number visible (slam animation + settle time)
    await sleep(isGo ? 820 : 680)

    // Explode out
    numEl.classList.remove('cd-slam-in', 'cd-go-slam')
    void numEl.offsetWidth
    numEl.classList.add(isGo ? 'cd-go-explode' : 'cd-explode-out')

    await sleep(isGo ? 360 : 210)

    // Clear for next step
    numEl.classList.remove('cd-explode-out', 'cd-go-explode')
    numEl.textContent = ''

    if (!isGo) await sleep(75)
  }

  // Tear down
  if (_cdPRafId) { cancelAnimationFrame(_cdPRafId); _cdPRafId = null }
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  _cdParticles = []
  overlay.classList.add('hidden')
}

// ── Leaderboard helpers ───────────────────────────────────────────────────────
async function showLeaderboard() {
  showScreen('leaderboard')
  $('lb-loading').classList.remove('hidden')
  $('lb-error').classList.add('hidden')
  $('lb-table').classList.add('hidden')

  if (!isConfigured()) {
    $('lb-loading').classList.add('hidden')
    $('lb-error').textContent = 'Leaderboard not configured yet. See SETUP.md.'
    $('lb-error').classList.remove('hidden')
    return
  }

  try {
    const rows = await getTopScores(10)
    $('lb-loading').classList.add('hidden')

    const tbody = $('lb-body')
    tbody.innerHTML = ''

    if (rows.length === 0) {
      $('lb-error').textContent = 'No scores yet. Be the first!'
      $('lb-error').classList.remove('hidden')
      return
    }

    rows.forEach((row, i) => {
      const tr   = document.createElement('tr')
      const date = new Date(row.created_at).toLocaleDateString()
      if (row.player_name === playerName) tr.classList.add('highlight')
      tr.innerHTML = `
        <td>${i + 1}</td>
        <td>${escapeHtml(row.player_name)}</td>
        <td>${row.score}</td>
        <td>${date}</td>
      `
      tbody.appendChild(tr)
    })

    $('lb-table').classList.remove('hidden')
  } catch (err) {
    $('lb-loading').classList.add('hidden')
    $('lb-error').textContent = `Error loading leaderboard: ${err.message}`
    $('lb-error').classList.remove('hidden')
  }
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ── Button handlers ───────────────────────────────────────────────────────────

// Name screen
$('btn-save-name').addEventListener('click', () => { sfxClick(); saveName() })
$('name-input').addEventListener('keydown', e => { if (e.key === 'Enter') saveName() })

async function saveName() {
  // Once a name is stored it cannot be changed
  if (localStorage.getItem('cvsnake_player')) {
    goToMenu()
    return
  }

  const val = $('name-input').value.trim().slice(0, 20)
  const errorEl = $('name-error')
  errorEl.textContent = ''
  errorEl.classList.add('hidden')

  if (!val) {
    $('name-input').focus()
    return
  }

  if (isConfigured()) {
    const taken = await checkNameExists(val)
    if (taken) {
      errorEl.textContent = 'Name already taken. Choose a different one.'
      errorEl.classList.remove('hidden')
      $('name-input').focus()
      return
    }
  }

  playerName = val
  localStorage.setItem('cvsnake_player', playerName)
  goToMenu()
}

// Menu screen
$('btn-play').addEventListener('click', async () => {
  sfxClick()
  showScreen('game')
  await initCamera()
  startMusic()
  resetGame()           // also calls refreshGameLeaderboard()
  await runCountdown()
  startGameLoop()
})

$('btn-leaderboard-menu').addEventListener('click', () => { sfxClick(); showLeaderboard() })

$('btn-tutorial').addEventListener('click', () => { sfxClick(); showTutorial() })

$('btn-tut-exit').addEventListener('click', () => {
  if (!tutDone.every(Boolean)) {
    $('tut-exit-modal').classList.remove('hidden')
  } else {
    stopTutorial()
    goToMenu()
  }
})

$('btn-tut-exit-confirm').addEventListener('click', () => {
  $('tut-exit-modal').classList.add('hidden')
  stopTutorial()
  goToMenu()
})

$('btn-tut-exit-cancel').addEventListener('click', () => {
  $('tut-exit-modal').classList.add('hidden')
})

$('btn-tut-continue').addEventListener('click', async () => {
  stopTutorial()
  showScreen('game')
  await initCamera()
  startMusic()
  resetGame()
  await runCountdown()
  startGameLoop()
})

// Game-over overlay
$('btn-play-again').addEventListener('click', async () => {
  resetGame()
  await runCountdown()
  startGameLoop()
})

$('btn-menu-from-over').addEventListener('click', () => {
  if (rafId) cancelAnimationFrame(rafId)
  goToMenu()
})

// Leaderboard screen
$('btn-back-lb').addEventListener('click', goToMenu)

// Mute button
$('btn-mute').addEventListener('click', () => {
  musicMuted = !musicMuted
  bgMusic.muted = musicMuted
  $('btn-mute').textContent = musicMuted ? '🔇 UNMUTE' : '🔊 MUTE'
  $('btn-mute').classList.toggle('muted', musicMuted)
})

// ── Keyboard controls ─────────────────────────────────────────────────────────
const KEY_TO_DIR = {
  ArrowUp:    'UP',
  ArrowDown:  'DOWN',
  ArrowLeft:  'LEFT',
  ArrowRight: 'RIGHT',
}

document.addEventListener('keydown', e => {
  if (currentScreen === 'game' && gameState === 'playing') {
    const dir = KEY_TO_DIR[e.key]
    if (dir) {
      e.preventDefault()
      snake.setDirection(dir)
    }
  }
  if (e.key === 'r' || e.key === 'R') {
    if (currentScreen === 'game' && gameState === 'over') {
      resetGame()
      runCountdown().then(startGameLoop)
    }
  }
  if (e.key === 'Escape') {
    if (currentScreen === 'game') {
      if (rafId) cancelAnimationFrame(rafId)
      goToMenu()
    } else if (currentScreen === 'leaderboard') {
      goToMenu()
    } else if (currentScreen === 'tutorial') {
      if (!tutDone.every(Boolean)) {
        $('tut-exit-modal').classList.remove('hidden')
      } else {
        stopTutorial()
        goToMenu()
      }
    }
  }
})

// ── Helpers ───────────────────────────────────────────────────────────────────
function goToMenu() {
  stopMusic()
  showScreen('menu')
  $('welcome-text').textContent = `FIGHTER ${playerName} — READY FOR BATTLE`
}

// ── Boot ──────────────────────────────────────────────────────────────────────
playerName = localStorage.getItem('cvsnake_player') || ''

if (playerName) {
  goToMenu()
} else {
  showScreen('name')
}
