// Entry of the phone page (remote.html), served to phones by remote.rs.
// No Tauri imports anywhere under src/remote: this runs in a phone browser.
import React from 'react';
import ReactDOM from 'react-dom/client';
import RemoteApp from './RemoteApp';
import '../index.css';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <RemoteApp />
  </React.StrictMode>,
);
