import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter, Route, Routes } from 'react-router-dom';
import App from './App';
import OverlayScreen from './screens/OverlayScreen';
import '@fontsource-variable/inter';
import './index.css';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <HashRouter>
      <Routes>
        {/* The overlay window: no db, OBS or settings boot, just live://state events. */}
        <Route path="/overlay" element={<OverlayScreen />} />
        <Route path="*" element={<App />} />
      </Routes>
    </HashRouter>
  </React.StrictMode>,
);
