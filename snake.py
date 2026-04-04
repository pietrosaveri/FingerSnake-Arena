# Legacy entry point — the game has been reorganised into main.py + game/
# You can run either:  python snake.py  OR  python main.py
from main import main

if __name__ == "__main__":
    main()

# ── Everything below is kept only for reference ───────────────────────────────
import sys as _sys
_sys.exit(0)   # prevent old code from running

import cv2
import pygame
import random
import sys
import numpy as np
from collections import deque

# ── Game settings ─────────────────────────────────────────────────────────────
CELL_SIZE   = 20
GRID_W      = 32
GRID_H      = 24
WIN_W       = CELL_SIZE * GRID_W   # 640
WIN_H       = CELL_SIZE * GRID_H   # 480
MOVE_DELAY  = 130  # ms between snake steps (lower = faster)

# ── Colours ───────────────────────────────────────────────────────────────────
BLACK      = (  0,   0,   0)
DARK_GRAY  = ( 25,  25,  25)
GREEN      = (  0, 200,  50)
HEAD_GREEN = (  0, 255,  80)
RED        = (220,  30,  30)
WHITE      = (255, 255, 255)
YELLOW     = (255, 220,   0)

# ── Directions (dx, dy) ───────────────────────────────────────────────────────
UP    = ( 0, -1)
DOWN  = ( 0,  1)
LEFT  = (-1,  0)
RIGHT = ( 1,  0)


# ═══════════════════════════════════════════════════════════════════════════════
class Snake:
    def __init__(self):
        self.reset()

    def reset(self):
        sx, sy = GRID_W // 2, GRID_H // 2
        self.body      = [(sx, sy), (sx - 1, sy), (sx - 2, sy)]
        self.direction = RIGHT
        self._grow     = False

    def set_direction(self, new_dir):
        # Prevent 180° reversal
        if (new_dir[0] * -1, new_dir[1] * -1) != self.direction:
            self.direction = new_dir

    def step(self):
        hx, hy = self.body[0]
        self.body.insert(0, (hx + self.direction[0], hy + self.direction[1]))
        if not self._grow:
            self.body.pop()
        self._grow = False

    def eat(self, food):
        if self.body[0] == food:
            self._grow = True
            return True
        return False

    def is_dead(self):
        hx, hy = self.body[0]
        if not (0 <= hx < GRID_W and 0 <= hy < GRID_H):
            return True
        return self.body[0] in self.body[1:]


# ═══════════════════════════════════════════════════════════════════════════════
class HandController:
    """
    Pure-OpenCV hand tracker using skin-colour segmentation.

    Strategy
    --------
    Convert each frame to YCrCb + HSV, build a skin mask, find the largest
    contour (the hand), track its centroid over the last N frames and emit
    a direction when the displacement crosses a threshold.
    """
    HISTORY   = 14   # frames to keep
    THRESHOLD = 40   # pixel displacement to register a swipe
    COOLDOWN  = 20   # frames to ignore after a swipe
    MIN_AREA  = 4000 # minimum contour area to count as a hand

    def __init__(self):
        self.history  = deque(maxlen=self.HISTORY)
        self.cooldown = 0
        # Morphology kernel
        self._kernel  = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))

    # ── Skin mask ─────────────────────────────────────────────────────────────
    def _skin_mask(self, frame):
        # YCrCb range for skin
        ycrcb = cv2.cvtColor(frame, cv2.COLOR_BGR2YCrCb)
        mask_y = cv2.inRange(ycrcb,
                             np.array([0,  133, 77],  dtype=np.uint8),
                             np.array([255, 173, 127], dtype=np.uint8))
        # HSV range for skin
        hsv    = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
        mask_h = cv2.inRange(hsv,
                             np.array([0,  15,  60],  dtype=np.uint8),
                             np.array([20, 170, 255], dtype=np.uint8))
        mask = cv2.bitwise_and(mask_y, mask_h)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN,  self._kernel, iterations=2)
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, self._kernel, iterations=3)
        return mask

    # ── Main update ───────────────────────────────────────────────────────────
    def process(self, frame):
        """
        Returns (direction | None, annotated_frame).
        frame must already be horizontally flipped (mirror mode).
        """
        h, w   = frame.shape[:2]
        mask   = self._skin_mask(frame)
        out    = frame.copy()

        detected_dir = None

        # Find the largest skin contour
        cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if cnts:
            largest = max(cnts, key=cv2.contourArea)
            area    = cv2.contourArea(largest)
            if area >= self.MIN_AREA:
                cv2.drawContours(out, [largest], -1, (0, 200, 0), 2)
                M  = cv2.moments(largest)
                if M["m00"] > 0:
                    cx = int(M["m10"] / M["m00"])
                    cy = int(M["m01"] / M["m00"])
                    cv2.circle(out, (cx, cy), 12, (0, 255, 255), -1)
                    self.history.append((cx, cy))

        # Tick cooldown
        if self.cooldown > 0:
            self.cooldown -= 1

        # Direction detection
        if len(self.history) >= self.HISTORY // 2 and self.cooldown == 0:
            pts = list(self.history)
            dx  = pts[-1][0] - pts[0][0]
            dy  = pts[-1][1] - pts[0][1]
            adx, ady = abs(dx), abs(dy)
            if max(adx, ady) >= self.THRESHOLD:
                if adx >= ady:
                    detected_dir = RIGHT if dx > 0 else LEFT
                else:
                    # Camera y-axis inverted: downward pixel motion = DOWN
                    detected_dir = DOWN if dy > 0 else UP
                self.cooldown = self.COOLDOWN
                self.history.clear()

        self._draw_hud(out, detected_dir, w, h)
        return detected_dir, out

    @staticmethod
    def _draw_hud(frame, direction, w, h):
        arrows = {UP: "^ UP", DOWN: "v DOWN", LEFT: "< LEFT", RIGHT: "> RIGHT"}
        label  = arrows.get(direction, "")
        if label:
            cv2.putText(frame, label, (10, h - 15),
                        cv2.FONT_HERSHEY_SIMPLEX, 1.1, (0, 255, 255), 2)
        cv2.putText(frame, "Move hand to steer snake", (10, 30),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (200, 200, 200), 1)
        cv2.putText(frame, "Keep hand against plain background", (10, 55),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (150, 150, 150), 1)


# ═══════════════════════════════════════════════════════════════════════════════
def spawn_food(body):
    while True:
        pos = (random.randint(0, GRID_W - 1), random.randint(0, GRID_H - 1))
        if pos not in body:
            return pos


def draw_game(surface, snake, food, score, font_sm, font_lg, game_over):
    surface.fill(BLACK)

    # Subtle grid
    for x in range(0, WIN_W, CELL_SIZE):
        pygame.draw.line(surface, DARK_GRAY, (x, 0), (x, WIN_H))
    for y in range(0, WIN_H, CELL_SIZE):
        pygame.draw.line(surface, DARK_GRAY, (0, y), (WIN_W, y))

    # Food (pulsing red square)
    fx, fy = food
    pygame.draw.rect(surface, RED,
                     (fx * CELL_SIZE + 2, fy * CELL_SIZE + 2, CELL_SIZE - 4, CELL_SIZE - 4))

    # Snake
    for i, (sx, sy) in enumerate(snake.body):
        colour = HEAD_GREEN if i == 0 else GREEN
        pygame.draw.rect(surface, colour,
                         (sx * CELL_SIZE + 1, sy * CELL_SIZE + 1, CELL_SIZE - 2, CELL_SIZE - 2),
                         border_radius=4)

    # Score
    surface.blit(font_sm.render(f"Score: {score}", True, WHITE), (8, 8))

    # Game-over screen
    if game_over:
        overlay = pygame.Surface((WIN_W, WIN_H), pygame.SRCALPHA)
        overlay.fill((0, 0, 0, 160))
        surface.blit(overlay, (0, 0))

        go  = font_lg.render("GAME OVER", True, RED)
        sc  = font_sm.render(f"Final score: {score}", True, WHITE)
        rst = font_sm.render("Press  R  to restart   |   Q  to quit", True, YELLOW)

        surface.blit(go,  go.get_rect(center=(WIN_W // 2, WIN_H // 2 - 60)))
        surface.blit(sc,  sc.get_rect(center=(WIN_W // 2, WIN_H // 2)))
        surface.blit(rst, rst.get_rect(center=(WIN_W // 2, WIN_H // 2 + 55)))


# ═══════════════════════════════════════════════════════════════════════════════
def main():
    # ── Camera ────────────────────────────────────────────────────────────────
    cap = cv2.VideoCapture(0)
    if not cap.isOpened():
        print("ERROR: Cannot open webcam. Make sure it is connected.")
        sys.exit(1)

    # ── Pygame ────────────────────────────────────────────────────────────────
    pygame.init()
    screen  = pygame.display.set_mode((WIN_W, WIN_H))
    pygame.display.set_caption("CV Snake  —  Control with your hand")
    clock   = pygame.time.Clock()
    font_sm = pygame.font.SysFont("monospace", 22, bold=True)
    font_lg = pygame.font.SysFont("monospace", 52, bold=True)

    # ── State ─────────────────────────────────────────────────────────────────
    controller  = HandController()
    snake       = Snake()
    food        = spawn_food(snake.body)
    score       = 0
    game_over   = False
    last_step   = pygame.time.get_ticks()

    print("\n  CV Snake is running!")
    print("  ├─ Move your hand UP / DOWN / LEFT / RIGHT to steer.")
    print("  ├─ Arrow keys also work as a fallback.")
    print("  └─ Press Q to quit.\n")

    while True:
        # ── Events ────────────────────────────────────────────────────────────
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                cap.release(); cv2.destroyAllWindows(); pygame.quit(); sys.exit()

            if event.type == pygame.KEYDOWN:
                if event.key == pygame.K_q:
                    cap.release(); cv2.destroyAllWindows(); pygame.quit(); sys.exit()
                if event.key == pygame.K_r and game_over:
                    snake.reset()
                    food      = spawn_food(snake.body)
                    score     = 0
                    game_over = False
                if not game_over:
                    key_map = {
                        pygame.K_UP:    UP,
                        pygame.K_DOWN:  DOWN,
                        pygame.K_LEFT:  LEFT,
                        pygame.K_RIGHT: RIGHT,
                    }
                    if event.key in key_map:
                        snake.set_direction(key_map[event.key])

        # ── Camera frame ──────────────────────────────────────────────────────
        ret, frame = cap.read()
        if ret:
            frame = cv2.flip(frame, 1)          # mirror = natural movement
            direction, annotated = controller.process(frame)

            if direction and not game_over:
                snake.set_direction(direction)

            cv2.imshow("Hand Cam  (move your hand to steer)", annotated)
            cv2.waitKey(1)

        # ── Snake logic ───────────────────────────────────────────────────────
        if not game_over:
            now = pygame.time.get_ticks()
            if now - last_step >= MOVE_DELAY:
                snake.step()
                last_step = now

                if snake.eat(food):
                    score += 10
                    food = spawn_food(snake.body)

                if snake.is_dead():
                    game_over = True

        # ── Render ────────────────────────────────────────────────────────────
        draw_game(screen, snake, food, score, font_sm, font_lg, game_over)
        pygame.display.flip()
        clock.tick(60)


if __name__ == "__main__":
    main()
