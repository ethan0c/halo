const box = document.getElementById('selection');
let start = null;
let rect = null;
function point(event) {
  return { x: Math.max(0, Math.min(innerWidth, Math.floor(event.clientX))), y: Math.max(0, Math.min(innerHeight, Math.floor(event.clientY))) };
}
function update(event) {
  const end = point(event);
  rect = { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) };
  for (const [key, value] of Object.entries({ left: rect.x, top: rect.y, width: rect.width, height: rect.height })) box.style[key] = `${value}px`;
}
document.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  start = point(event);
  document.body.setPointerCapture(event.pointerId);
  box.hidden = false;
  update(event);
});
document.addEventListener('pointermove', event => { if (start) update(event); });
document.addEventListener('pointerup', event => {
  if (!start) return;
  update(event);
  start = null;
  if (rect.width >= 8 && rect.height >= 8) window.captureArea.finish(rect);
  else { box.hidden = true; document.getElementById('hint').textContent = 'Select an area at least 8 × 8 pixels · Esc to cancel'; }
});
document.addEventListener('keydown', event => { if (event.key === 'Escape') window.captureArea.finish(null); });
