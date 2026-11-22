import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import AuthGate from './AuthGate';
import './styles.css';
import './spec/spec.css';
import './home/home.css';
import { primeAiBridge } from './ai/aiBridge';

/* Founder 2026-11-22: the AI connects by itself, like the printer. If no AI address is
 * stored yet, ask this computer for the claude-bridge first (a refused port answers at once;
 * a hung one is cut at 1.5 s), so every panel opens with the address already filled. */
const store = (() => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
})();
void primeAiBridge(store).finally(render);

function render() {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <AuthGate>
        <App />
      </AuthGate>
    </StrictMode>
  );
}
