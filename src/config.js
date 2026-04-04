// ── Display ───────────────────────────────────────────────────────────────────
export const CELL_SIZE  = 44
export const GRID_W     = 16
export const GRID_H     = 12
export const WIN_W      = CELL_SIZE * GRID_W   // 704
export const WIN_H      = CELL_SIZE * GRID_H   // 528
export const MOVE_DELAY = 180                   // ms between snake steps

// ── Direction objects (dx, dy in grid units) ──────────────────────────────────
export const DIRECTIONS = {
  UP:    { dx:  0, dy: -1 },
  DOWN:  { dx:  0, dy:  1 },
  LEFT:  { dx: -1, dy:  0 },
  RIGHT: { dx:  1, dy:  0 },
}

export const OPPOSITE = {
  UP: 'DOWN', DOWN: 'UP',
  LEFT: 'RIGHT', RIGHT: 'LEFT',
}
