import React from 'react';
import ReactDOM from 'react-dom/client';
import { initThemeSync } from '@/lib/ui/theme';
import { PreviewPageApp } from './PreviewPageApp';
import '../sidepanel/global.css';

initThemeSync();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <PreviewPageApp />
  </React.StrictMode>,
);
