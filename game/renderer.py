import pygame
from game.config import (
    WIN_W, WIN_H, CELL_SIZE,
    BLACK, DARK_GRAY, GREEN, HEAD_GREEN, RED, WHITE, YELLOW, BLUE, BUTTON_HOVER,
)

_STATE_COLORS = {
    "NO_GESTURE": ( 90,  90,  90),
    "NEUTRAL":    (  0, 210, 100),
    "TRIGGERED":  (  0, 210, 230),
}


def _draw_button(surface, rect, text, font, mouse_pos, base_col, hover_col):
    col = hover_col if rect.collidepoint(mouse_pos) else base_col
    pygame.draw.rect(surface, col, rect, border_radius=8)
    pygame.draw.rect(surface, WHITE, rect, 2, border_radius=8)
    lbl = font.render(text, True, WHITE)
    surface.blit(lbl, lbl.get_rect(center=rect.center))


def _draw_grid(surface):
    for x in range(0, WIN_W, CELL_SIZE):
        pygame.draw.line(surface, DARK_GRAY, (x, 0), (x, WIN_H))
    for y in range(0, WIN_H, CELL_SIZE):
        pygame.draw.line(surface, DARK_GRAY, (0, y), (WIN_W, y))


# ── Main menu ─────────────────────────────────────────────────────────────────

def draw_menu(surface, font_sm, font_lg, mouse_pos):
    """Draw the main menu. Returns (play_rect, quit_rect)."""
    surface.fill(BLACK)
    _draw_grid(surface)

    title = font_lg.render("CV  SNAKE", True, HEAD_GREEN)
    surface.blit(title, title.get_rect(center=(WIN_W // 2, WIN_H // 2 - 120)))

    sub = font_sm.render("Wave your hand to steer the snake", True, (180, 180, 180))
    surface.blit(sub, sub.get_rect(center=(WIN_W // 2, WIN_H // 2 - 65)))

    play_rect = pygame.Rect(WIN_W // 2 - 100, WIN_H // 2 - 10, 200, 55)
    quit_rect = pygame.Rect(WIN_W // 2 - 100, WIN_H // 2 + 65, 200, 55)

    _draw_button(surface, play_rect, "PLAY", font_sm, mouse_pos, BLUE,          BUTTON_HOVER)
    _draw_button(surface, quit_rect, "QUIT", font_sm, mouse_pos, (140, 30, 30), (210, 50, 50))

    return play_rect, quit_rect


# ── In-game ───────────────────────────────────────────────────────────────────

def draw_game(surface, snake, food, score, font_sm, hand_state):
    surface.fill(BLACK)
    _draw_grid(surface)

    # Food
    fx, fy = food
    pygame.draw.rect(
        surface, RED,
        (fx * CELL_SIZE + 2, fy * CELL_SIZE + 2, CELL_SIZE - 4, CELL_SIZE - 4),
    )

    # Snake body
    for i, (sx, sy) in enumerate(snake.body):
        colour = HEAD_GREEN if i == 0 else GREEN
        pygame.draw.rect(
            surface, colour,
            (sx * CELL_SIZE + 1, sy * CELL_SIZE + 1, CELL_SIZE - 2, CELL_SIZE - 2),
            border_radius=4,
        )

    # Score (top-left)
    surface.blit(font_sm.render(f"Score: {score}", True, WHITE), (8, 8))

    # Hand-state badge (top-right)
    hcol  = _STATE_COLORS.get(hand_state, (90, 90, 90))
    label = {"NO_GESTURE": "no hand", "NEUTRAL": "ready", "TRIGGERED": "fired"}.get(hand_state, hand_state)
    hlbl  = font_sm.render(label, True, hcol)
    surface.blit(hlbl, (WIN_W - hlbl.get_width() - 8, 8))


# ── Game-over overlay ─────────────────────────────────────────────────────────

def draw_game_over(surface, score, font_sm, font_lg, mouse_pos):
    """Draw game-over overlay on top of the frozen game frame.
    Returns (reset_rect, menu_rect)."""
    overlay = pygame.Surface((WIN_W, WIN_H), pygame.SRCALPHA)
    overlay.fill((0, 0, 0, 160))
    surface.blit(overlay, (0, 0))

    go_lbl = font_lg.render("GAME  OVER", True, RED)
    sc_lbl = font_sm.render(f"Final score:  {score}", True, WHITE)
    surface.blit(go_lbl, go_lbl.get_rect(center=(WIN_W // 2, WIN_H // 2 - 80)))
    surface.blit(sc_lbl, sc_lbl.get_rect(center=(WIN_W // 2, WIN_H // 2 - 20)))

    # Two side-by-side buttons centred on screen
    cx = WIN_W // 2
    reset_rect = pygame.Rect(cx - 215, WIN_H // 2 + 30, 195, 55)
    menu_rect  = pygame.Rect(cx +  20, WIN_H // 2 + 30, 195, 55)

    _draw_button(surface, reset_rect, "RESET", font_sm, mouse_pos, BLUE,          BUTTON_HOVER)
    _draw_button(surface, menu_rect,  "MENU",  font_sm, mouse_pos, (140, 30, 30), (210, 50, 50))

    return reset_rect, menu_rect
