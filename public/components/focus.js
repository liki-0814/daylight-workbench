// Pointer interactions stay quiet; keyboard navigation keeps a visible focus cue.
const root = document.documentElement;
root.dataset.inputMode = 'pointer';
document.addEventListener('pointerdown', () => { root.dataset.inputMode = 'pointer'; }, true);
document.addEventListener('keydown', event => {
  if (['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' '].includes(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey) root.dataset.inputMode = 'keyboard';
}, true);
