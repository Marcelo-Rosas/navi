import React, { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
    children: ReactNode;
    fallback?: ReactNode;
  }

interface State {
    hasError: boolean;
    error: Error | null;
  }

/**
 * RootErrorBoundary — captura erros não tratados na árvore React e
 * exibe uma UI de fallback amigável em vez de tela em branco.
 */
export class RootErrorBoundary extends Component<Props, State> {
    constructor(props: Props) {
          super(props);
          this.state = { hasError: false, error: null };
        }

    static getDerivedStateFromError(error: Error): State {
          return { hasError: true, error };
        }

    componentDidCatch(error: Error, info: ErrorInfo): void {
          console.error('[RootErrorBoundary] Uncaught error:', error, info.componentStack);
        }

    render(): ReactNode {
          if (this.state.hasError) {
                  if (this.props.fallback) return this.props.fallback;
                  return (
                            <div
                              style={{
                                            padding: 32,
                                            fontFamily: 'system-ui, sans-serif',
                                            maxWidth: 600,
                                            margin: '80px auto',
                                            lineHeight: 1.6,
                                          }}
                            >
                              <h1 style={{ fontSize: '1.25rem', color: '#b91c1c', marginBottom: 12 }}>
                                Algo deu errado
                              </h1>
                              <p style={{ marginBottom: 16, color: '#374151' }}>
                                Um erro inesperado ocorreu. Tente recarregar a página.
                              </p>
                              <pre
                                style={{
                                                background: '#fef2f2',
                                                border: '1px solid #fecaca',
                                                borderRadius: 8,
                                                padding: 12,
                                                fontSize: 12,
                                                overflowX: 'auto',
                                                whiteSpace: 'pre-wrap',
                                                color: '#7f1d1d',
                                              }}
                              >
                                {this.state.error?.message}
                              </pre>
                              <button
                                onClick={() => window.location.reload()}
                                style={{
                                                marginTop: 20,
                                                padding: '8px 20px',
                                                background: '#1d4ed8',
                                                color: '#fff',
                                                border: 'none',
                                                borderRadius: 6,
                                                cursor: 'pointer',
                                                fontSize: 14,
                                              }}
                              >
                                Recarregar
                              </button>
                            </div>
                          );
                }
          return this.props.children;
        }
  }
