"""
CV Snake — Hand-Controlled Edition
===================================
Run with:
    python main.py

Controls
--------
  Wave hand UP / DOWN / LEFT / RIGHT  →  steer the snake
  Arrow keys                          →  backup keyboard control
  R                                   →  restart after game over
  Q                                   →  quit
"""

import sys
import cv2
import pygame

from game.config import WIN_W, WIN_H, MOVE_DELAY, UP, DOWN, LEFT, RIGHT
from game.snake import Snake, spawn_food
from game.hand_tracker import HandTracker
from game.renderer import draw_menu, draw_game, draw_game_over


def main():
    # ── Webcam ────────────────────────────────────────────────────────────────
    cap = cv2.VideoCapture(0)
    if not cap.isOpened():
        print("ERROR: Cannot open webcam.")
        sys.exit(1)

    # ── Pygame ────────────────────────────────────────────────────────────────
    pygame.init()
    screen  = pygame.display.set_mode((WIN_W, WIN_H))
    pygame.display.set_caption("CV Snake — Wave your hand to steer")
    clock   = pygame.time.Clock()
    font_sm = pygame.font.SysFont("monospace", 22, bold=True)
    font_lg = pygame.font.SysFont("monospace", 52, bold=True)

    # ── Game objects ──────────────────────────────────────────────────────────
    tracker    = HandTracker()
    snake      = Snake()
    food       = spawn_food(snake.body)
    score      = 0
    last_step  = pygame.time.get_ticks()
    hand_state = "none"

    # ── State machine: "menu" | "playing" | "game_over" ───────────────────────
    state     = "menu"
    menu_btns = None   # (play_rect, quit_rect)  — refreshed each frame
    over_btns = None   # (reset_rect, menu_rect) — refreshed each frame

    print("\n  CV Snake is running!")
    print("  ├─ Wave your hand  UP / DOWN / LEFT / RIGHT  to steer.")
    print("  ├─ Arrow keys also work as a backup.")
    print("  └─ Press Q to quit  |  R to restart after game-over.\n")

    while True:
        mouse_pos = pygame.mouse.get_pos()

        # ── Events ────────────────────────────────────────────────────────────
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                _quit(cap)

            # ── Mouse: button clicks ──────────────────────────────────────────
            if event.type == pygame.MOUSEBUTTONDOWN and event.button == 1:
                if state == "menu" and menu_btns:
                    play_r, quit_r = menu_btns
                    if play_r.collidepoint(event.pos):
                        snake.reset()
                        food      = spawn_food(snake.body)
                        score     = 0
                        last_step = pygame.time.get_ticks()
                        state     = "playing"
                    elif quit_r.collidepoint(event.pos):
                        _quit(cap)

                elif state == "game_over" and over_btns:
                    reset_r, menu_r = over_btns
                    if reset_r.collidepoint(event.pos):
                        snake.reset()
                        food      = spawn_food(snake.body)
                        score     = 0
                        last_step = pygame.time.get_ticks()
                        state     = "playing"
                    elif menu_r.collidepoint(event.pos):
                        cv2.destroyAllWindows()
                        state = "menu"

            # ── Keyboard shortcuts ────────────────────────────────────────────
            if event.type == pygame.KEYDOWN:
                if event.key == pygame.K_q:
                    _quit(cap)

                if event.key == pygame.K_r and state == "game_over":
                    snake.reset()
                    food      = spawn_food(snake.body)
                    score     = 0
                    last_step = pygame.time.get_ticks()
                    state     = "playing"

                if state == "playing":
                    _KEY_DIR = {
                        pygame.K_UP:    UP,
                        pygame.K_DOWN:  DOWN,
                        pygame.K_LEFT:  LEFT,
                        pygame.K_RIGHT: RIGHT,
                    }
                    if event.key in _KEY_DIR:
                        snake.set_direction(_KEY_DIR[event.key])

        # ── Camera (always drain buffer; only process when playing) ───────────
        ret, frame = cap.read()
        if ret and state == "playing":
            frame = cv2.flip(frame, 1)
            direction, annotated, hand_state = tracker.process(frame)
            if direction:
                snake.set_direction(direction)
            cv2.imshow("Hand Tracking — Wave to steer", annotated)
            cv2.waitKey(1)

        # ── Snake step ────────────────────────────────────────────────────────
        if state == "playing":
            now = pygame.time.get_ticks()
            if now - last_step >= MOVE_DELAY:
                snake.step()
                last_step = now
                if snake.eat(food):
                    score += 10
                    food = spawn_food(snake.body)
                if snake.is_dead():
                    state = "game_over"

        # ── Draw ──────────────────────────────────────────────────────────────
        if state == "menu":
            menu_btns = draw_menu(screen, font_sm, font_lg, mouse_pos)
        elif state == "playing":
            draw_game(screen, snake, food, score, font_sm, hand_state)
        elif state == "game_over":
            draw_game(screen, snake, food, score, font_sm, hand_state)
            over_btns = draw_game_over(screen, score, font_sm, font_lg, mouse_pos)

        pygame.display.flip()
        clock.tick(60)


def _quit(cap):
    cap.release()
    cv2.destroyAllWindows()
    pygame.quit()
    sys.exit()


if __name__ == "__main__":
    main()
