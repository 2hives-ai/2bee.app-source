// DEV-SERVER-ONLY mount of <PcbTab/>, so the tab is exercised before the parent
// session wires it into App.tsx / Tabs.tsx (not this change's files). Loaded only
// by web/e2e-harness/pcb.html, which index.html does not reference and `vite
// build` does not bundle. `?board=<id>` opens a board through the same handoff
// the Designs page uses (`pcbHandoff.ts`).
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles.css';
import PcbTab from './PcbTab';
import { openInPcb } from './pcbHandoff';

const q = new URLSearchParams(location.search);
document.documentElement.dataset.theme = q.get('theme') === 'dark' ? 'dark' : 'light';
const board = q.get('board');
if (board) openInPcb(board);
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <PcbTab active />
    </div>
  </StrictMode>,
);
