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
  $('tut-prog-fill').style.background = frac >= 1 ? 'var(--green)' : 'var(--blue)'
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
$('btn-play').addEventListener('click', async () => { sfxClick()
  showScreen('game')
  await initCamera()
  startMusic()
  resetGame()           // also calls refreshGameLeaderboard()
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
  startGameLoop()
})

// Game-over overlay
$('btn-play-again').addEventListener('click', () => {
  resetGame()
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
      startGameLoop()
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
