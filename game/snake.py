import random
from game.config import GRID_W, GRID_H, RIGHT


class Snake:
    def __init__(self):
        self.reset()

    def reset(self):
        sx, sy         = GRID_W // 2, GRID_H // 2
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

    def eat(self, food: tuple) -> bool:
        if self.body[0] == food:
            self._grow = True
            return True
        return False

    def is_dead(self) -> bool:
        hx, hy = self.body[0]
        if not (0 <= hx < GRID_W and 0 <= hy < GRID_H):
            return True
        return self.body[0] in self.body[1:]


def spawn_food(body: list) -> tuple:
    while True:
        pos = (random.randint(0, GRID_W - 1), random.randint(0, GRID_H - 1))
        if pos not in body:
            return pos
