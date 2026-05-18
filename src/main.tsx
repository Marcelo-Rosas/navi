import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import { RootErrorBoundary } from './components/RootErrorBoundary';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim();
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();

if (!supabaseUrl || !supabaseKey) {
  root.render(
    <div
      style={{
        padding: 24,
        fontFamily: 'system-ui, sans-serif',
        maxWidth: 560,
        lineHeight: 1.5,
      }}
    >
      <h1 style={{ fontSize: '1.25rem', marginBottom: 12 }}>
        Variáveis do Supabase ausentes
      </h1>
      <p>
        Crie <code>.env.local</code> na raiz do projeto (mesma pasta do{' '}
        <code>package.json</code>) com:
      </p>
      <pre
        style={{
          background: '#f4f4f5',
          padding: 12,
          overflow: 'auto',
          borderRadius: 8,
          fontSize: 13,
        }}
      >
        {`VITE_SUPABASE_URL=https://xxxx.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=eyJ...`}
      </pre>
      <p>
        Se estiver no WSL, copie do Windows:{' '}
        <code>cp /mnt/c/Users/SEU_USUARIO/navi/.env* ~/dev/navi/</code>
      </p>
      <p>Reinicie o servidor: <code>npm run dev</code></p>
    </div>
  );
} else {
  import('./App')
    .then(({ default: App }) => {
      root.render(
        <React.StrictMode>
          <RootErrorBoundary>
            <App />
          </RootErrorBoundary>
        </React.StrictMode>
      );
    })
    .catch((err: unknown) => {
      console.error('[main] Falha ao carregar App:', err);
      const msg = err instanceof Error ? err.message : String(err);
      root.render(
        <div
          style={{
            padding: 24,
            fontFamily: 'system-ui, sans-serif',
            maxWidth: 640,
            lineHeight: 1.5,
          }}
        >
          <h1 style={{ fontSize: '1.25rem', marginBottom: 12, color: '#b91c1c' }}>
            Falha ao carregar o módulo da aplicação
          </h1>
          <pre
            style={{
              background: '#fef2f2',
              padding: 12,
              overflow: 'auto',
              borderRadius: 8,
              fontSize: 13,
              whiteSpace: 'pre-wrap',
            }}
          >
            {msg}
          </pre>
          <p style={{ marginTop: 16 }}>
            Confira o terminal do Vite e o console (F12). Se estiver no WSL, rode
            o projeto na pasta onde está o <code>package.json</code> e o{' '}
            <code>.env.local</code>.
          </p>
        </div>
      );
    });
}