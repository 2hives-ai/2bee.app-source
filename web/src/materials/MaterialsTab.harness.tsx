// DEV-SERVER-ONLY mount of <MaterialsTab/>, so the tab is exercised before the
// parent session wires it into App.tsx / Tabs.tsx (not this change's files).
// Loaded only by web/e2e-harness/materials.html, which index.html does not
// reference and `vite build` does not bundle.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles.css';
import MaterialsTab from './MaterialsTab';

document.documentElement.dataset.theme = new URLSearchParams(location.search).get('theme') === 'dark' ? 'dark' : 'light';
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <MaterialsTab active />
    </div>
  </StrictMode>,
);
