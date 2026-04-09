import { GRID_W, GRID_H, DIRECTIONS, OPPOSITE } from './config.js'

export class Snake {
  constructor() { this.reset() }

  reset() {
    const sx = Math.floor(GRID_W / 2)
    const sy = Math.floor(GRID_H / 2)
    this.body        = [[sx, sy], [sx - 1, sy], [sx - 2, sy]]
    this.direction   = 'RIGHT'
    this._lastMoved  = 'RIGHT'
    this._grow       = false
  }

  setDirection(newDir) {
    // Guard against reversals using the direction the snake *actually* moved last
    // tick, not the queued direction. This prevents rapid webcam updates within a
    // single tick from queuing a direction that doubles back into the body.
    if (newDir !== OPPOSITE[this._lastMoved]) {
      this.direction = newDir
    }
  }

  step() {
    const [hx, hy]    = this.body[0]
    const { dx, dy }  = DIRECTIONS[this.direction]
    this.body.unshift([hx + dx, hy + dy])
    if (!this._grow) this.body.pop()
    this._grow      = false
    this._lastMoved = this.direction
  }

  eat(food) {
    if (this.body[0][0] === food[0] && this.body[0][1] === food[1]) {
      this._grow = true
      return true
    }
    return false
  }

  isDead() {
    const [hx, hy] = this.body[0]
    if (hx < 0 || hx >= GRID_W || hy < 0 || hy >= GRID_H) return true
    return this.body.slice(1).some(([x, y]) => x === hx && y === hy)
  }
}

export function spawnFood(body) {
  let pos
  do {
    pos = [
      Math.floor(Math.random() * GRID_W),
      Math.floor(Math.random() * GRID_H),
    ]
  } while (body.some(([x, y]) => x === pos[0] && y === pos[1]))
  return pos
}
