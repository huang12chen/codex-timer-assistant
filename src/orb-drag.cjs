'use strict';

// Cursor coordinates and window bounds are both device-independent pixels.
function createOrbDrag({ cursor, window, workArea }) {
  let origin = null;
  return {
    begin() {
      const win = window();
      if (!win || win.isDestroyed()) return;
      origin = { cursor: cursor(), bounds: win.getBounds() };
    },
    move() {
      const win = window();
      if (!origin || !win || win.isDestroyed()) return;
      const point = cursor(), area = workArea(point), bounds = origin.bounds;
      const x = bounds.x + point.x - origin.cursor.x;
      const y = bounds.y + point.y - origin.cursor.y;
      // Keep a reachable part of the orb on the current display.
      win.setPosition(Math.round(Math.max(area.x - bounds.width + 32, Math.min(x, area.x + area.width - 32))),
        Math.round(Math.max(area.y - bounds.height + 32, Math.min(y, area.y + area.height - 32))));
    },
    end() { origin = null; }
  };
}
module.exports = { createOrbDrag };
