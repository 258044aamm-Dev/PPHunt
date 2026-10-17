import React from 'react';
import ReactDOM from 'react-dom/client';
import App from '../sidepanel/App';
import { initThemeSync } from '@/lib/ui/theme';
import '../sidepanel/global.css';

initThemeSync();

function closeOverlay() {
  // The host only honors this message from its own extension-origin iframe.
  // M-4 (SAD-183): send it TO that origin too — with '*' the host page could
  // observe the close event (extension presence + UI state disclosure).
  window.parent.postMessage(
    { type: 'PPHUNT_CLOSE_OVERLAY' },
    window.location.origin
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App onClose={closeOverlay} />
  </React.StrictMode>
);
