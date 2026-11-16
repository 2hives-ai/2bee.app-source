// DEV-ONLY: the entry of `web/print3d.html`, which mounts the 2bee.3d tab on
// its own so `e2e/print3d.spec.ts` can drive it before App.tsx wires the tab
// in. Not imported by the app; `vite build` does not bundle it.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles.css';
import { Print3dTab } from './Print3dTab';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>
      <Print3dTab />
    </div>
  </StrictMode>,
);
