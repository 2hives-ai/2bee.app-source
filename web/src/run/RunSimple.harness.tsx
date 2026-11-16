// DEV-SERVER-ONLY mount of <RunSimple/> for e2e/run-simple.spec.ts, so the
// component is tested before App.tsx mounts it (App.tsx is not this file's to
// edit). Loaded only by web/e2e-harness/run-simple.html, which index.html does
// not reference and `vite build` does not bundle.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles.css';
import RunSimple from './RunSimple';

document.documentElement.dataset.theme = new URLSearchParams(location.search).get('theme') === 'dark' ? 'dark' : 'light';
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <RunSimple />
    </div>
  </StrictMode>,
);
