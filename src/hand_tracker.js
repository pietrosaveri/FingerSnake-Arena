/**
 * HandTracker — JavaScript port of game/hand_tracker.py
 * ======================================================
 * Uses @mediapipe/tasks-vision HandLandmarker (same Tasks API as Python).
 *
 * The video frame is expected to already be horizontally flipped (mirror view)
 * so that pointing right in front of you sends the snake RIGHT.
 *
 * Direction conventions (same as Python, y-axis flipped so 90° = UP):
 *   RIGHT =   0°   LEFT = ±180°
 *   UP    =  90°   DOWN =  -90°
 */

import { HandLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'

// ── CDN paths ─────────────────────────────────────────────────────────────────
const WASM_URL  = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/' +
  'hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'

// ── Landmark indices ──────────────────────────────────────────────────────────
const _WRIST       = 0
const _INDEX_TIP   = 8;  const _INDEX_PIP   = 7;  const _INDEX_MCP = 5
const _MIDDLE_TIP  = 12; const _MIDDLE_PIP  = 11
const _RING_TIP    = 16; const _RING_PIP    = 14
const _PINKY_TIP   = 20; const _PINKY_PIP   = 18

// ── Bone connections for skeleton drawing ────────────────────────────────────
const CONNECTIONS = [
  [0,1],[1,2],[2,3],[3,4],
  [0,5],[5,6],[6,7],[7,8],
  [0,9],[9,10],[10,11],[11,12],
  [0,13],[13,14],[14,15],[15,16],
  [0,17],[17,18],[18,19],[19,20],
  [5,9],[9,13],[13,17],
]
const ACTIVE_IDS = new Set([5,6,7,8,9,10,11,12])
const TIP_IDS    = new Set([8, 12])

// ── Controller parameters (mirrors Python) ───────────────────────────────────
const STREAK_NEEDED = 2
const EMA_ALPHA     = 0.5
const HYSTERESIS    = 20  // extra degrees to leave current direction
const LR_BIAS       = 10  // extra arc given to LEFT/RIGHT

export class HandTracker {
  constructor() {
    this._landmarker   = null
    this._smoothCos    = null
    this._smoothSin    = null
    this._streakDir    = null
    this._streakCount  = 0
    this.lastDir       = null    // last confirmed direction
    this.handState     = 'none' // 'none' | 'fist' | 'pointing'
    this.lastLandmarks = null
    this.smoothedAngle = 0
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  async init() {
    const vision = await FilesetResolver.forVisionTasks(WASM_URL)
    this._landmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: MODEL_URL,
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      numHands: 1,
      minHandDetectionConfidence: 0.70,
      minHandPresenceConfidence:  0.70,
      minTrackingConfidence:      0.60,
    })
  }

  get isReady() { return this._landmarker !== null }

  /**
   * Process one frame.
   * @param {HTMLCanvasElement} source  - pre-flipped video frame (mirror view)
   * @param {number}            tsMs   - performance.now() timestamp in ms
   * @returns {{ direction: string|null, state: string, landmarks: array|null }}
   */
  process(source, tsMs) {
    if (!this._landmarker) {
      return { direction: null, state: this.handState, landmarks: this.lastLandmarks }
    }

    const result = this._landmarker.detectForVideo(source, tsMs)

    if (!result.landmarks || result.landmarks.length === 0) {
      this._streakDir   = null
      this._streakCount = 0
      this._smoothCos   = null
      this._smoothSin   = null
      this.handState    = 'none'
      this.lastLandmarks = null
      return { direction: null, state: 'none', landmarks: null }
    }

    const lms = result.landmarks[0]
    this.lastLandmarks = lms

    // Fist → no command, reset streak
    if (this._isFist(lms)) {
      this._streakDir   = null
      this._streakCount = 0
      this._smoothCos   = null
      this._smoothSin   = null
      this.handState    = 'fist'
      return { direction: null, state: 'fist', landmarks: lms }
    }

    // Index finger must be extended
    if (!this._isIndexExtended(lms)) {
      this.handState = 'none'
      return { direction: null, state: 'none', landmarks: lms }
    }

    // ── Compute angle (90° = UP, -90° = DOWN, 0° = RIGHT, ±180° = LEFT) ──
    const mcp    = lms[_INDEX_MCP]
    const tip    = lms[_INDEX_TIP]
    const dx     = tip.x - mcp.x
    const dy     = -(tip.y - mcp.y)    // flip y so up is positive
    const angRad = Math.atan2(dy, dx)
    const angDeg = angRad * 180 / Math.PI

    // ── EMA smoothing on (cos, sin) to handle ±180° wrap ─────────────────
    const c = Math.cos(angRad), s = Math.sin(angRad)
    if (this._smoothCos === null) {
      this._smoothCos = c
      this._smoothSin = s
    } else {
      this._smoothCos = EMA_ALPHA * c + (1 - EMA_ALPHA) * this._smoothCos
      this._smoothSin = EMA_ALPHA * s + (1 - EMA_ALPHA) * this._smoothSin
    }
    const smoothed       = Math.atan2(this._smoothSin, this._smoothCos) * 180 / Math.PI
    this.smoothedAngle   = smoothed

    // ── Classify with hysteresis ──────────────────────────────────────────
    const raw = this._classifyWithHysteresis(smoothed)

    if (raw === this._streakDir) {
      this._streakCount++
    } else {
      this._streakDir   = raw
      this._streakCount = 1
    }

    let emitted = null
    if (this._streakCount >= STREAK_NEEDED) {
      this.lastDir = raw
      emitted      = raw     // fires every frame while holding the pose
    }

    this.handState = 'pointing'
    return { direction: emitted, state: 'pointing', landmarks: lms, angle: smoothed }
  }

  // ── Gesture helpers ─────────────────────────────────────────────────────────

  /** All four fingers curled (tip closer to wrist than PIP). */
  _isFist(lms) {
    const wx = lms[_WRIST].x, wy = lms[_WRIST].y
    return [
      [_INDEX_TIP,  _INDEX_PIP ],
      [_MIDDLE_TIP, _MIDDLE_PIP],
      [_RING_TIP,   _RING_PIP  ],
      [_PINKY_TIP,  _PINKY_PIP ],
    ].every(([t, p]) => {
      const td = Math.hypot(lms[t].x - wx, lms[t].y - wy)
      const pd = Math.hypot(lms[p].x - wx, lms[p].y - wy)
      return td <= pd
    })
  }

  /** Index fingertip is further from wrist than PIP (finger is extended). */
  _isIndexExtended(lms) {
    const wx = lms[_WRIST].x, wy = lms[_WRIST].y
    const td = Math.hypot(lms[_INDEX_TIP].x - wx, lms[_INDEX_TIP].y - wy)
    const pd = Math.hypot(lms[_INDEX_PIP].x - wx, lms[_INDEX_PIP].y - wy)
    return td > pd
  }

  /** Basic 4-quadrant classification; LEFT/RIGHT get a wider arc (+LR_BIAS). */
  _classifyAngle(a) {
    const b = LR_BIAS
    if (a >= -(45 + b) && a <  (45 + b)) return 'RIGHT'
    if (a >=  (45 + b) && a < (135 - b)) return 'UP'
    if (a >= (135 - b) || a < -(135 - b)) return 'LEFT'
    return 'DOWN'
  }

  /** Sticky classification: must deviate > base + HYSTERESIS to change dir. */
  _classifyWithHysteresis(a) {
    if (this.lastDir !== null) {
      const centers   = { RIGHT: 0, UP: 90, DOWN: -90, LEFT: 180 }
      const baseHalves = {
        RIGHT: 45 + LR_BIAS,  LEFT: 45 + LR_BIAS,
        UP:    45 - LR_BIAS,  DOWN: 45 - LR_BIAS,
      }
      const center = centers[this.lastDir]
      const delta  = ((a - center + 180) % 360) - 180
      if (Math.abs(delta) < baseHalves[this.lastDir] + HYSTERESIS) {
        return this.lastDir
      }
    }
    return this._classifyAngle(a)
  }

  // ── Drawing ─────────────────────────────────────────────────────────────────

  /**
   * Draw hand skeleton over a canvas.  Landmarks are in [0,1] normalised coords
   * relative to the canvas dimensions provided.
   */
  drawLandmarks(ctx, landmarks, width, height) {
    if (!landmarks) return

    // Bones
    CONNECTIONS.forEach(([a, b]) => {
      const active = ACTIVE_IDS.has(a) || ACTIVE_IDS.has(b)
      ctx.strokeStyle = active ? '#00f078' : '#dcaa32'
      ctx.lineWidth   = 2
      ctx.beginPath()
      ctx.moveTo(landmarks[a].x * width, landmarks[a].y * height)
      ctx.lineTo(landmarks[b].x * width, landmarks[b].y * height)
      ctx.stroke()
    })

    // Joints
    landmarks.forEach((pt, i) => {
      const x = pt.x * width, y = pt.y * height
      let color = '#3c8cff', size = 3
      if (TIP_IDS.has(i))        { color = '#00ff5a'; size = 5 }
      else if (i === _WRIST)     { color = '#c83c3c'; size = 4 }
      else if (ACTIVE_IDS.has(i)){ color = '#00c864'; size = 3 }

      ctx.beginPath()
      ctx.arc(x, y, size, 0, Math.PI * 2)
      ctx.fillStyle   = color
      ctx.fill()
      ctx.strokeStyle = 'rgba(255,255,255,0.7)'
      ctx.lineWidth   = 1
      ctx.stroke()
    })
  }
}
