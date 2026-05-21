# NAVI — Vectra Cargo

Assistente WhatsApp (Nina) para a Vectra Cargo: onboarding, conversas, fila de envio e integração com **Meta WhatsApp Cloud API**.

| Ambiente | URL |
|----------|-----|
| Produção | https://navi.vectracargo.com.br |
| Supabase | https://ijkeuncfyaonjermwggl.supabase.co |

Documentação completa de requisitos, stack e integrações: **[REQUIREMENTS.md](./REQUIREMENTS.md)**.

---

## Quick start (local)

**Pré-requisitos:** Node.js 18+

```bash
npm install
cp .env.example .env.local
```

Edite `.env.local` com a **anon key** do projeto [`ijkeuncfyaonjermwggl`](https://supabase.com/dashboard/project/ijkeuncfyaonjermwggl/settings/api):

```env
VITE_SUPABASE_PROJECT_ID=ijkeuncfyaonjermwggl
VITE_SUPABASE_URL=https://ijkeuncfyaonjermwggl.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=<sua_anon_key>
```

```bash
npm run dev
```

O app exige `VITE_SUPABASE_*`; sem elas, a tela inicial mostra instruções de configuração.

---

## WhatsApp (Meta)

1. **Configurações → APIs** — Access Token, Phone Number ID, WABA ID.
2. **Nova instância → Meta Cloud API → Registrar Meta** (sem QR Code).
3. **Webhook** — URL `…/functions/v1/whatsapp-webhook` + Verify Token (ver REQUIREMENTS §3.3).

> **Evolution API está deprecada** para novos projetos. Não use URL/API Key Evolution nem `evolution-webhook` em setups novos. Detalhes: [REQUIREMENTS.md §4](./REQUIREMENTS.md#4-whatsapp--evolution-api-deprecado).

---

## Deploy

| Alvo | Notas |
|------|--------|
| **Cloudflare Pages** | Definir `VITE_SUPABASE_*` no painel; build `npm run build` |
| **Edge Functions** | `npx supabase functions deploy <fn> --project-ref ijkeuncfyaonjermwggl` |

Não commitar `.env` ou chaves. Template: [`.env.example`](.env.example).

---

## Estrutura do repositório

```
src/                    # App React (Vite)
supabase/
  functions/            # Edge Functions (whatsapp-*, create-meta-instance, …)
  migrations/           # Schema Postgres
.cursor/skills/         # Contexto mínimo para agentes (cargo-flow-navigator)
REQUIREMENTS.md         # Requisitos e integrações (fonte da verdade)
```

---

## Scripts

| Comando | Descrição |
|---------|-----------|
| `npm run dev` | Dev server Vite |
| `npm run build` | Build produção |
| `npm run preview` | Preview do build |
| `npm run navi:local` | Orquestrador local (`local-runner/`) |

---

## Licença / origem

Projeto derivado de template AI Studio; operação atual é **NAVI / Vectra Cargo** com Supabase `ijkeuncfyaonjermwggl` (não usar o projeto Supabase antigo do remix `ohbocxuvzrgzqkjocyns`).
