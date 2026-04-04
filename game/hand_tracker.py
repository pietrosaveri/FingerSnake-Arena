"""
Direct-pointing hand controller for CV Snake.
==============================================

Gesture
-------
  Point your index + middle fingers in the direction you want:
    ↑  UP    — fingers pointing straight up
    ←  LEFT  — fingers pointing left
    →  RIGHT — fingers pointing right
    ↓  DOWN  — fingers pointing down
  Make a fist → stop sending commands (NO_GESTURE).

How steering works
------------------
  1. The angle of INDEX_MCP → INDEX_TIP is computed every frame.
     Using the knuckle-to-tip vector gives pure finger orientation with no
     hand-position noise (wrist offset doesn't affect it).
  2. The angle is exponentially smoothed (EMA, α=0.5, on cos/sin components
     to handle the ±180° wrap correctly).  This kills per-frame jitter.
  3. Direction classification with hysteresis: once locked on a direction,
     the smoothed angle must deviate 65° (45°+20° margin) from that direction's
     centre before a reclassification fires.  Prevents flickering near the
     diagonal 45° boundaries when pointing is slightly imprecise.
  4. A 2-frame consecutive-streak filter emits the final direction.
  5. The direction fires continuously while you hold the pose; the snake
     ignores redundant same-direction calls so no spurious turns happen.

No baseline calibration, no dead-zone return, no re-arm step required.
"""

import math
import os
import time
import urllib.request
import cv2
import mediapipe as mp
import numpy as np
from mediapipe.tasks.python.vision import (
    HandLandmarker,
    HandLandmarkerOptions,
    RunningMode,
)

from game.config import UP, DOWN, LEFT, RIGHT

# ── Model ──────────────────────────────────────────────────────────────────────
_MODEL_DIR  = os.path.join(os.path.dirname(__file__), "..", "models")
_MODEL_PATH = os.path.join(_MODEL_DIR, "hand_landmarker.task")
_MODEL_URL  = (
    "https://storage.googleapis.com/mediapipe-models/"
    "hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task"
)

# ── Landmark indices ───────────────────────────────────────────────────────────
_WRIST      = 0
_INDEX_TIP  = 8;  _INDEX_PIP  = 7;  _INDEX_MCP  = 5
_MIDDLE_TIP = 12; _MIDDLE_PIP = 11; _MIDDLE_MCP = 9
_RING_TIP   = 16; _RING_PIP   = 14
_PINKY_TIP  = 20; _PINKY_PIP  = 18

# Bone connections  (a, b) → draw line between landmark a and b
_CONNECTIONS = [
    (0, 1), (1, 2), (2, 3), (3, 4),           # thumb
    (0, 5), (5, 6), (6, 7), (7, 8),           # index
    (0, 9), (9, 10), (10, 11), (11, 12),      # middle
    (0, 13), (13, 14), (14, 15), (15, 16),    # ring
    (0, 17), (17, 18), (18, 19), (19, 20),    # pinky
    (5, 9), (9, 13), (13, 17),                # palm knuckle bar
]

# Which landmark indices belong to index/middle fingers (highlighted in green)
_ACTIVE_IDS = {5, 6, 7, 8, 9, 10, 11, 12}
_TIP_IDS    = {8, 12}   # index + middle tips (larger circles)
_OTHER_TIPS = {4, 16, 20}

# ── Controller parameters ──────────────────────────────────────────────────────
_STREAK_NEEDED = 2    # consecutive identical readings to emit a direction
_EMA_ALPHA     = 0.5  # EMA weight for angle smoothing (higher = faster/noisier)
_HYSTERESIS    = 20   # extra degrees needed to leave the current direction
_LR_BIAS       = 10   # extra arc degrees given to LEFT/RIGHT (taken from UP/DOWN)


def _ensure_model() -> str:
    os.makedirs(_MODEL_DIR, exist_ok=True)
    if not os.path.exists(_MODEL_PATH):
        print("  Downloading hand landmarker model (~8 MB) …")
        urllib.request.urlretrieve(_MODEL_URL, _MODEL_PATH)
        print("  Model saved to", _MODEL_PATH)
    return _MODEL_PATH


class HandTracker:
    def __init__(self):
        model_path = _ensure_model()
        options = HandLandmarkerOptions(
            base_options=mp.tasks.BaseOptions(model_asset_path=model_path),
            running_mode=RunningMode.VIDEO,
            num_hands=1,
            min_hand_detection_confidence=0.70,
            min_hand_presence_confidence=0.70,
            min_tracking_confidence=0.60,
        )
        self._det      = HandLandmarker.create_from_options(options)
        self._t0       = int(time.time() * 1000)
        self._last_ts  = 0

        # Controller state
        self._state        = "NO_GESTURE"   # NO_GESTURE | POINTING
        self._streak_dir   = None           # last confirmed raw direction
        self._streak_count = 0              # consecutive frames of streak_dir
        self._smooth_cos   = None           # EMA components for angle
        self._smooth_sin   = None
        self._cur_angle    = 0.0            # smoothed angle for HUD display
        self.last_dir      = None

    # ── Gesture helpers ────────────────────────────────────────────────────────

    def _is_fist(self, lms) -> bool:
        """All four fingers curled → fist → no command.
        Uses Euclidean distance from wrist so it works in any orientation.
        A curled finger has its tip CLOSER to the wrist than its PIP joint.
        """
        wx, wy = lms[_WRIST].x, lms[_WRIST].y
        for tip_idx, pip_idx in (
            (_INDEX_TIP,  _INDEX_PIP),
            (_MIDDLE_TIP, _MIDDLE_PIP),
            (_RING_TIP,   _RING_PIP),
            (_PINKY_TIP,  _PINKY_PIP),
        ):
            tip_d = math.hypot(lms[tip_idx].x - wx, lms[tip_idx].y - wy)
            pip_d = math.hypot(lms[pip_idx].x - wx, lms[pip_idx].y - wy)
            if tip_d > pip_d:   # this finger is extended → not a fist
                return False
        return True

    def _index_extended(self, lms) -> bool:
        """Index finger is extended — works in any pointing direction.
        Extended = tip is further from the wrist than the PIP joint.
        """
        wx, wy = lms[_WRIST].x, lms[_WRIST].y
        tip_d = math.hypot(lms[_INDEX_TIP].x - wx, lms[_INDEX_TIP].y - wy)
        pip_d = math.hypot(lms[_INDEX_PIP].x - wx, lms[_INDEX_PIP].y - wy)
        return tip_d > pip_d

    # ── Angle-based direction detection ───────────────────────────────────────

    def _get_pointing_angle(self, lms) -> float:
        """
        Angle (degrees) of INDEX_MCP → INDEX_TIP.
          0°   = pointing right
          90°  = pointing up
         ±180° = pointing left
         -90°  = pointing down
        Uses the knuckle→tip vector so hand position in frame doesn't affect the
        reading. (Image y-axis is inverted, hence the -dy.)
        """
        bx, by = lms[_INDEX_MCP].x, lms[_INDEX_MCP].y
        fx, fy = lms[_INDEX_TIP].x, lms[_INDEX_TIP].y
        return math.degrees(math.atan2(-(fy - by), fx - bx))

    def _angle_to_dir(self, angle: float):
        """Classify into the nearest cardinal direction.
        LEFT/RIGHT get a wider arc (+_LR_BIAS on each side) because they are
        physically harder to point precisely; UP/DOWN are proportionally narrower.
        """
        b = _LR_BIAS
        if   -(45 + b) <= angle <  (45 + b): return RIGHT
        elif  (45 + b) <= angle < (135 - b): return UP
        elif angle >= (135 - b) or angle < -(135 - b): return LEFT
        else:                                return DOWN

    def _angle_to_dir_hysteresis(self, angle: float):
        """Like _angle_to_dir but sticky: once locked on a direction, require
        the angle to deviate beyond the base arc + _HYSTERESIS before
        reclassifying.  LEFT/RIGHT get the extra _LR_BIAS on top."""
        if self.last_dir is not None:
            _CENTERS   = {RIGHT: 0.0, UP: 90.0, DOWN: -90.0, LEFT: 180.0}
            _BASE_HALF = {RIGHT: 45 + _LR_BIAS, LEFT: 45 + _LR_BIAS,
                          UP:   45 - _LR_BIAS,  DOWN: 45 - _LR_BIAS}
            center = _CENTERS[self.last_dir]
            delta  = ((angle - center) + 180) % 360 - 180
            if abs(delta) < (_BASE_HALF[self.last_dir] + _HYSTERESIS):
                return self.last_dir
        return self._angle_to_dir(angle)

    # ── State machine (greatly simplified) ────────────────────────────────────

    def _tick(self, lms):
        """
        Every frame:
          • fist      → reset all state, NO_GESTURE, return None
          • finger up → EMA-smooth the angle, classify with hysteresis,
                        update streak counter, emit after _STREAK_NEEDED
        """
        if self._is_fist(lms):
            self._state        = "NO_GESTURE"
            self._streak_dir   = None
            self._streak_count = 0
            self._smooth_cos   = None
            self._smooth_sin   = None
            return None

        if not self._index_extended(lms):
            return None

        # Raw angle from the better MCP→tip vector
        angle = self._get_pointing_angle(lms)

        # EMA smoothing on (cos, sin) — handles ±180° wraparound cleanly
        c, s = math.cos(math.radians(angle)), math.sin(math.radians(angle))
        if self._smooth_cos is None:
            self._smooth_cos, self._smooth_sin = c, s
        else:
            self._smooth_cos = _EMA_ALPHA * c + (1 - _EMA_ALPHA) * self._smooth_cos
            self._smooth_sin = _EMA_ALPHA * s + (1 - _EMA_ALPHA) * self._smooth_sin
        smoothed = math.degrees(math.atan2(self._smooth_sin, self._smooth_cos))
        self._cur_angle = smoothed

        # Classify with hysteresis to avoid boundary flickering
        raw = self._angle_to_dir_hysteresis(smoothed)

        if raw == self._streak_dir:
            self._streak_count += 1
        else:
            self._streak_dir   = raw
            self._streak_count = 1

        if self._streak_count < _STREAK_NEEDED:
            return None

        self._state   = "POINTING"
        self.last_dir = self._streak_dir
        return self._streak_dir

    # ── Drawing ────────────────────────────────────────────────────────────────

    def _draw_skeleton(self, frame, lms, w: int, h: int):
        # Bones
        for a, b in _CONNECTIONS:
            active = a in _ACTIVE_IDS or b in _ACTIVE_IDS
            color  = (0, 240, 120) if active else (220, 170, 50)
            cv2.line(
                frame,
                (int(lms[a].x * w), int(lms[a].y * h)),
                (int(lms[b].x * w), int(lms[b].y * h)),
                color, 2, cv2.LINE_AA,
            )

        # Joints
        for i, pt in enumerate(lms):
            x, y = int(pt.x * w), int(pt.y * h)
            if i in _TIP_IDS:
                col, size = (0, 255, 90), 6
            elif i in _OTHER_TIPS:
                col, size = (70, 110, 200), 4
            elif i == _WRIST:
                col, size = (200, 60, 60), 5
            elif i in _ACTIVE_IDS:
                col, size = (0, 200, 100), 3
            else:
                col, size = (60, 140, 255), 3
            cv2.circle(frame, (x, y), size, col,          -1, cv2.LINE_AA)
            cv2.circle(frame, (x, y), size, (255,255,255), 1,  cv2.LINE_AA)

    def _draw_direction_indicator(self, frame, w: int, h: int):
        """
        Small compass arrow in the bottom-right showing the current pointing
        angle as a line, plus the classified direction label.
        """
        CX, CY = w - 70, h - 70
        R = 50

        _STATE_COL = {
            "NO_GESTURE": (80,  80,  80),
            "POINTING":   (0,  210, 100),
        }
        col = _STATE_COL.get(self._state, (80, 80, 80))

        # Background disc
        cv2.circle(frame, (CX, CY), R, (25, 25, 25), -1)
        cv2.circle(frame, (CX, CY), R, (80, 80, 80),  1)

        # Cardinal labels
        for label, ox, oy in [("U",-5,-R+12), ("D",-5,R-6), ("L",-R+6,5), ("R",R-14,5)]:
            cv2.putText(frame, label, (CX+ox, CY+oy),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.38, (110, 110, 110), 1)

        # Arrow pointing in current angle direction
        if self._state == "POINTING":
            ang_rad = math.radians(self._cur_angle)
            ex = CX + int((R - 10) * math.cos(ang_rad))
            ey = CY - int((R - 10) * math.sin(ang_rad))   # screen y inverted
            cv2.arrowedLine(frame, (CX, CY), (ex, ey), col, 2,
                            cv2.LINE_AA, tipLength=0.35)

        # State label below disc
        cv2.putText(frame, self._state, (CX - 35, CY + R + 14),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.36, col, 1, cv2.LINE_AA)

    def _draw_hud(self, frame, direction, w: int, h: int):
        _ARROWS = {UP: "^ UP", DOWN: "v DOWN", LEFT: "< LEFT", RIGHT: "> RIGHT"}
        _STATE_COL = {
            "NO_GESTURE": (120, 120, 120),
            "POINTING":   (  0, 210, 100),
        }
        col = _STATE_COL.get(self._state, (120, 120, 120))

        cv2.putText(frame,
                    "Point fingers to steer  |  Fist = stop",
                    (10, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (200, 200, 200), 1, cv2.LINE_AA)
        cv2.putText(frame, f"[ {self._state} ]",
                    (10, 55), cv2.FONT_HERSHEY_SIMPLEX, 0.65, col, 2, cv2.LINE_AA)

        if direction:
            label = _ARROWS.get(direction, "")
            cv2.putText(frame, label, (10, h - 14),
                        cv2.FONT_HERSHEY_SIMPLEX, 1.4, (0, 255, 255), 3, cv2.LINE_AA)

    # ── Public API ─────────────────────────────────────────────────────────────

    def process(self, frame) -> tuple:
        """
        Parameters
        ----------
        frame : BGR image, already horizontally flipped (mirror mode).

        Returns
        -------
        (direction | None, annotated_frame, state_str)
          direction  — UP / DOWN / LEFT / RIGHT  or  None
          state_str  — "NO_GESTURE" | "POINTING"
        """
        h, w = frame.shape[:2]
        out  = frame.copy()

        ts_ms = max(int(time.time() * 1000) - self._t0, self._last_ts + 1)
        self._last_ts = ts_ms

        mp_img = mp.Image(image_format=mp.ImageFormat.SRGB,
                          data=cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
        result = self._det.detect_for_video(mp_img, ts_ms)

        direction = None

        if result.hand_landmarks:
            lms = result.hand_landmarks[0]
            self._draw_skeleton(out, lms, w, h)
            direction = self._tick(lms)
        else:
            self._state        = "NO_GESTURE"
            self._streak_dir   = None
            self._streak_count = 0
            self._smooth_cos   = None
            self._smooth_sin   = None

        self._draw_direction_indicator(out, w, h)
        self._draw_hud(out, direction, w, h)
        return direction, out, self._state
