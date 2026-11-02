// A click anywhere on the orb opens the assistant; a movement starts a drag.
export function bindOrbInteraction(button, invoke, onError) {
  let pointer = null, suppressClick = false, moving = false, chain = Promise.resolve();
  const send = action => invoke('window', { action });
  const enqueue = action => { chain = chain.then(() => send(action)).catch(onError); };
  function down(event) {
    if (event.button !== 0 || pointer) return;
    pointer = { id: event.pointerId, x: event.screenX, y: event.screenY, dragged: false };
    suppressClick = false;
    button.setPointerCapture(event.pointerId);
    enqueue('orbDragStart');
  }
  function move(event) {
    if (!pointer || event.pointerId !== pointer.id) return;
    if (!pointer.dragged && Math.hypot(event.screenX - pointer.x, event.screenY - pointer.y) >= 5) pointer.dragged = true;
    if (pointer.dragged && !moving) {
      moving = true;
      chain = chain.then(() => send('orbDragMove')).catch(onError).finally(() => { moving = false; });
    }
  }
  function finish(event, cancelled = false) {
    if (!pointer || event.pointerId !== pointer.id) return;
    const dragged = pointer.dragged;
    suppressClick = dragged || cancelled;
    pointer = null;
    if (dragged) enqueue('orbDragMove');
    enqueue('orbDragEnd');
  }
  function click(event) {
    if (suppressClick) { event.preventDefault(); suppressClick = false; return; }
    send('showMain').catch(onError);
  }
  const cancel = event => finish(event, true);
  button.addEventListener('pointerdown', down);
  button.addEventListener('pointermove', move);
  button.addEventListener('pointerup', finish);
  button.addEventListener('pointercancel', cancel);
  button.addEventListener('click', click);
  return () => {
    button.removeEventListener('pointerdown', down);
    button.removeEventListener('pointermove', move);
    button.removeEventListener('pointerup', finish);
    button.removeEventListener('pointercancel', cancel);
    button.removeEventListener('click', click);
    if (pointer) enqueue('orbDragEnd');
    pointer = null;
  };
}
