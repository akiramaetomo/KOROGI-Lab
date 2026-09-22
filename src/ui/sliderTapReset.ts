/** Native dblclick is unreliable on touch range inputs after the thumb moves. */
export function bindSliderReset(slider: HTMLInputElement, restore: () => void): void {
  slider.addEventListener('dblclick', () => { if (!slider.disabled) restore(); });
  slider.style.touchAction = 'manipulation';
  let down: { id: number; x: number; y: number; at: number } | null = null;
  let previous: { x: number; y: number; at: number } | null = null;
  const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
  slider.addEventListener('pointerdown', event => {
    if (event.pointerType === 'mouse' || slider.disabled) return;
    down = { id: event.pointerId, x: event.clientX, y: event.clientY, at: performance.now() };
  });
  slider.addEventListener('pointermove', event => {
    if (down?.id === event.pointerId && distance(down, { x: event.clientX, y: event.clientY }) > 9) {
      down = null; previous = null;
    }
  });
  slider.addEventListener('pointercancel', () => { down = null; previous = null; });
  slider.addEventListener('pointerup', event => {
    if (event.pointerType === 'mouse' || !down || down.id !== event.pointerId || slider.disabled) return;
    const tap = { x: event.clientX, y: event.clientY, at: performance.now() };
    const valid = tap.at - down.at <= 350 && distance(down, tap) <= 9;
    down = null;
    if (!valid) { previous = null; return; }
    if (previous && tap.at - previous.at <= 400 && distance(previous, tap) <= 24) {
      previous = null;
      // Apply after the native range input's final pointer value update.
      requestAnimationFrame(() => { if (!slider.disabled) restore(); });
    } else previous = tap;
  });
}
