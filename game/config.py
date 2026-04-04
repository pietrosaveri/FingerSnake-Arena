# ── Display ───────────────────────────────────────────────────────────────────
CELL_SIZE  = 20
GRID_W     = 32
GRID_H     = 24
WIN_W      = CELL_SIZE * GRID_W   # 640
WIN_H      = CELL_SIZE * GRID_H   # 480
MOVE_DELAY = 130                  # ms between snake steps

# ── Colours ───────────────────────────────────────────────────────────────────
BLACK      = (  0,   0,   0)
DARK_GRAY  = ( 25,  25,  25)
GREEN      = (  0, 200,  50)
HEAD_GREEN = (  0, 255,  80)
RED          = (220,  30,  30)
WHITE        = (255, 255, 255)
YELLOW       = (255, 220,   0)
BLUE         = ( 30, 100, 220)
BUTTON_HOVER = ( 60, 140, 255)

# ── Directions (dx, dy in grid units) ─────────────────────────────────────────
UP    = ( 0, -1)
DOWN  = ( 0,  1)
LEFT  = (-1,  0)
RIGHT = ( 1,  0)
