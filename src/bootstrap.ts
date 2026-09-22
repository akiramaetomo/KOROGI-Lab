// This entry can report errors even if the editable configuration cannot load.
try {
  const { validateParameterRanges } = await import('./config/parameterSafety');
  validateParameterRanges();
  await import('./main');
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const alert = document.querySelector<HTMLElement>('#audio-error');
  if (alert) { alert.textContent = `Configuration/startup error: ${message}`; alert.hidden = false; }
  const status = document.querySelector<HTMLElement>('#status');
  if (status) status.textContent = 'Initialization stopped';
  console.error(error);
}
