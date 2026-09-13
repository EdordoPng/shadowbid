const mascot = document.querySelector('[data-ghost-mascot]');

if (mascot) {
  const finePointer = matchMedia('(hover: hover) and (pointer: fine)');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const maxPupilTravel = 2;
  let frame, pointerX, pointerY, bounds;

  function centerEyes() {
    if (frame !== undefined) {
      cancelAnimationFrame(frame);
      frame = undefined;
    }
    mascot.style.removeProperty('--ghost-look-x');
    mascot.style.removeProperty('--ghost-look-y');
  }

  function renderEyes() {
    frame = undefined;
    bounds ??= mascot.getBoundingClientRect();
    const deltaX = pointerX - (bounds.left + bounds.width / 2);
    const deltaY = pointerY - (bounds.top + bounds.height / 2);
    const distance = Math.hypot(deltaX, deltaY);
    const scale = distance > 0 ? Math.min(maxPupilTravel / distance, 1) : 0;
    mascot.style.setProperty('--ghost-look-x', `${deltaX * scale}px`);
    mascot.style.setProperty('--ghost-look-y', `${deltaY * scale}px`);
  }

  function trackPointer(event) {
    if (event.pointerType !== 'mouse') return;
    pointerX = event.clientX;
    pointerY = event.clientY;
    if (frame === undefined) frame = requestAnimationFrame(renderEyes);
  }

  function invalidateBounds() {
    bounds = undefined;
  }

  function updateTracking() {
    window.removeEventListener('pointermove', trackPointer);
    if (finePointer.matches && !reducedMotion.matches) window.addEventListener('pointermove', trackPointer, { passive: true });
    else centerEyes();
  }

  finePointer.addEventListener('change', updateTracking);
  reducedMotion.addEventListener('change', updateTracking);
  window.addEventListener('resize', invalidateBounds, { passive: true });
  window.addEventListener('scroll', invalidateBounds, { passive: true });
  window.addEventListener('blur', centerEyes);
  document.addEventListener('mouseleave', centerEyes);
  updateTracking();
}
