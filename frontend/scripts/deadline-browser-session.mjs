// Subscribe at context creation: init-script errors can precede newPage() resolution.
export async function initializeDeadlineSession(context, { origin, session, demoMode = false, onPageError }) {
  context.on('weberror', event => onPageError(event.error()));
  await context.addInitScript(({ origin, session, demoMode }) => {
    // Initial about:blank pages and foreign origins must never access fixture credentials.
    // Do not catch storage failures on the authorized application origin.
    if (location.origin !== origin) return;
    localStorage.setItem('orbitflow.session.v1', JSON.stringify(session));
    if (demoMode) localStorage.setItem('orbitflow.demoMode', '0');
  }, { origin, session, demoMode });
}
