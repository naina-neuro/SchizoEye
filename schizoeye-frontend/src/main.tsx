import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import './styles/legacy.css';

// index.html's inline script redirects ?mode=test / ?token= / iframe loads to /battery.html.
// Don't mount React in that case — the page is about to navigate away.
if (!window.__SCHIZOEYE_REDIRECTING__) {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
