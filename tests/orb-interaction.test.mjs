import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { bindOrbInteraction } from '../ui/orb-interaction.mjs';
const require = createRequire(import.meta.url);
const { createOrbDrag } = require('../src/orb-drag.cjs');
const { validateCall } = require('../src/ipc-guard.cjs');

class Button {
  listeners = new Map();
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  removeEventListener(type) { this.listeners.delete(type); }
  setPointerCapture() {}
  emit(type, extra = {}) { this.listeners.get(type)?.({ button: 0, pointerId: 1, screenX: 20, screenY: 20, preventDefault() {}, ...extra }); }
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('orb click and keyboard activation open the main window; a drag does not', async () => {
  const button = new Button(), calls = [], errors = [];
  const dispose = bindOrbInteraction(button, async (_method, payload) => calls.push(payload.action), error => errors.push(error));
  button.emit('pointerdown'); button.emit('pointerup'); button.emit('click');
  await flush();
  assert.equal(calls.filter(x => x === 'showMain').length, 1);
  button.emit('click'); await flush();
  assert.equal(calls.filter(x => x === 'showMain').length, 2, 'keyboard click');
  button.emit('pointerdown'); button.emit('pointermove', { screenX: 35, screenY: 35 }); button.emit('pointerup', { screenX: 35, screenY: 35 }); button.emit('click');
  await flush();
  assert.equal(calls.filter(x => x === 'showMain').length, 2);
  assert.ok(calls.includes('orbDragMove'));
  assert.equal(calls.at(-1), 'orbDragEnd');
  assert.deepEqual(errors, []);
  dispose();
});

test('orb dragging uses screen-independent positions and remains reachable', () => {
  let point = { x: 100, y: 100 }, position;
  const win = { isDestroyed: () => false, getBounds: () => ({ x: 80, y: 70, width: 132, height: 132 }), setPosition: (x, y) => { position = { x, y }; } };
  const drag = createOrbDrag({ cursor: () => point, window: () => win, workArea: () => ({ x: 0, y: 0, width: 1000, height: 800 }) });
  drag.begin(); point = { x: 300, y: 250 }; drag.move();
  assert.deepEqual(position, { x: 280, y: 220 });
  point = { x: 5000, y: 5000 }; drag.move();
  assert.deepEqual(position, { x: 968, y: 768 });
  drag.end(); point = { x: 1, y: 1 }; drag.move();
  assert.deepEqual(position, { x: 968, y: 768 });
  assert.throws(() => validateCall('window', { action: 'orbDragMove' }, 'main'), /权限/);
  assert.equal(validateCall('window', { action: 'orbDragMove' }, 'orb'), 'window');
});
