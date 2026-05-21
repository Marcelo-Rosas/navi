# NAVI — Requirements

Documento de referência para desenvolvimento, deploy e integrações do **NAVI** (assistente WhatsApp da Vectra Cargo).

**Produção:** https://navi.vectracargo.com.br  
**Supabase:** projeto `ijkeuncfyaonjermwggl` — https://supabase.com/dashboard/project/ijkeuncfyaonjermwggl

---

## 1. Visão do produto

| Item | Requisito |
|------|-----------|
| Propósito | Atendimento e automação comercial/operacional via WhatsApp (agente Nina) |
| Tenant | Single-tenant (`nina_settings` global, `user_id` opcional) |
| Canal WhatsApp **obrigatório** | **Meta WhatsApp Cloud API** (Graph API v21+) |
| Canal WhatsApp **proibido para novos setups** | Evolution API (Baileys / QR) — **deprecado** |

---

## 2. Stack técnica

| Camada | Tecnologia |
|--------|------------|
| Frontend | Vite 5, React 18, TypeScript, Tailwind, Radix/shadcn, TanStack Query |
| Backend | Supabase (Postgres, Auth, Realtime, Edge Functions) |
| IA | Gemini (configurável em `nina_settings`) |
| Voz (opcional) | ElevenLabs |
| Deploy frontend | Cloudflare Pages (variáveis `VITE_*`) |
| Domínio | `navi.vectracargo.com.br` |

---

## 3. WhatsApp — Meta Cloud API (obrigatório)

### 3.1 Credenciais (`nina_settings`)

| Campo | Obrigatório | Descrição |
|-------|-------------|-----------|
| `whatsapp_access_token` | Sim | Token permanente ou de sistema com `whatsapp_business_messaging` |
| `whatsapp_phone_number_id` | Sim | ID do **número** (API Setup), só dígitos — não WABA ID nem App ID |
| `whatsapp_business_account_id` | Recomendado | WABA ID — listagem de templates aprovados |
| `whatsapp_verify_token` | Sim (webhook) | Token de verificação do webhook Meta |

### 3.2 Registro de conexão

- Não existe “instância” na Meta no mesmo sentido que Evolution.
- A NAVI registra uma linha em `whatsapp_instances` com `provider_type = 'official'` via Edge Function `create-meta-instance`.
- **Sem QR Code.**

### 3.3 Webhook de entrada

| Item | Valor |
|------|--------|
| URL | `{SUPABASE_URL}/functions/v1/whatsapp-webhook` |
| Verify Token | `nina_settings.whatsapp_verify_token` |
| Eventos Meta | `messages`, `message_echoes` (conforme painel) |

### 3.4 Envio de mensagens

| Fluxo | Implementação |
|-------|----------------|
| Fila operacional | `send_queue` → Edge Function `whatsapp-sender` (usa credenciais Meta em `nina_settings`) |
| Teste manual | Edge Function `test-whatsapp-message` (sessão usuário ou `service_role`) |
| Templates | `whatsapp-template-sender`; fora da janela 24h usar template aprovado (`hello_world` ou WABA) |
| Modo dev Meta | Números em **API Setup → To**; erro típico `131030` se não listado |

### 3.5 Edge Functions (Meta / ativas)

| Função | Papel |
|--------|--------|
| `whatsapp-webhook` | Recebimento Meta |
| `whatsapp-sender` | Envio da fila |
| `test-whatsapp-message` | Teste de envio (somente Meta) |
| `create-meta-instance` | Registrar conexão oficial em `whatsapp_instances` |
| `whatsapp-template-sender` | Templates Meta |
| `validate-setup` | Diagnóstico de onboarding (prioriza Meta) |

---

## 4. WhatsApp — Evolution API (DEPRECADO)

> **Status:** deprecado desde 2026-05. Não usar em novos ambientes, onboarding ou documentação de produto.

### 4.1 O que não fazer

- Não configurar `evolution_api_url` / `evolution_api_key` em novos deploys.
- Não criar instâncias Evolution pelo UI (removido do fluxo padrão).
- Não apontar webhook novo para `evolution-webhook`.

### 4.2 Código legado (manutenção apenas)

Mantido temporariamente para instâncias já existentes em produção:

| Função | Notas |
|--------|--------|
| `evolution-webhook` | Entrada Evolution |
| `create-evolution-instance` | Criação + QR |
| `get-evolution-qrcode` | Polling QR |
| `send-evolution-message` | Envio via Evolution |
| `delete-evolution-instance` | Remove (ignora API se `provider_type = official`) |
| `update-evolution-settings` | Sync settings Evolution |
| `check-instances-status` | Status instâncias Evolution |
| `test-evolution-connection` | Teste URL/key |

### 4.3 Migração Evolution → Meta

1. Configurar credenciais Meta (sec. 3.1).
2. Configurar webhook Meta (sec. 3.3).
3. Executar **Registrar Meta** (`create-meta-instance`).
4. Desativar instâncias Evolution (`is_active = false`) após validar envio/recebimento Meta.
5. Remover variáveis Evolution de `nina_settings` quando estável.

---

## 5. Variáveis de ambiente

### 5.1 Frontend (`.env.local` / Cloudflare)

```env
VITE_SUPABASE_PROJECT_ID=ijkeuncfyaonjermwggl
VITE_SUPABASE_URL=https://ijkeuncfyaonjermwggl.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=<anon_key>
```

- Prefixo **`VITE_`** obrigatório (Vite não expõe outras ao browser).
- Nunca commitar `.env` / `.env.local` — usar [`.env.example`](.env.example).

### 5.2 Edge Functions (Supabase Dashboard / secrets)

| Secret | Uso |
|--------|-----|
| `SUPABASE_URL` | Automático no deploy |
| `SUPABASE_SERVICE_ROLE_KEY` | Automático |
| `GEMINI_API_KEY` | IA (se aplicável à função) |

Credenciais WhatsApp Meta ficam em **`nina_settings`**, não em secrets globais (exceto scripts locais).

### 5.3 Opcional local

| Variável | Uso |
|----------|-----|
| `GEMINI_API_KEY` | Features AI Studio / prompts locais |

---

## 6. Onboarding (requisitos funcionais)

| Passo | Conteúdo | Obrigatório |
|-------|----------|-------------|
| Identidade | `company_name`, `sdr_name` | Sim |
| WhatsApp Cloud API | Token, Phone Number ID, WABA | Sim |
| Registrar conexão | `create-meta-instance` | Sim |
| Agente | `system_prompt_override` | Sim |
| ElevenLabs | API key | Não |
| Horário comercial | timezone / janela | Não |
| Verificação / Finalização | `validate-setup`, teste envio | Recomendado |

Conclusão persiste `onboarding_wizard_completed_at` em `nina_settings`.

---

## 7. Autenticação e papéis

| Papel | Escopo |
|-------|--------|
| `app_role` | `admin` \| `user` |
| `member_role` | `admin` \| `manager` \| `agent` |

Edge Functions de configuração/teste: JWT do usuário logado ou `service_role` (scripts).

---

## 8. Deploy

### 8.1 Frontend (Cloudflare Pages)

1. Build: `npm run build`
2. Variáveis `VITE_SUPABASE_*` no painel Cloudflare (projeto `ijkeuncfyaonjermwggl`).
3. Domínio: `navi.vectracargo.com.br`

### 8.2 Edge Functions

```bash
npx supabase functions deploy <nome> --project-ref ijkeuncfyaonjermwggl
```

Funções críticas WhatsApp: `whatsapp-webhook`, `whatsapp-sender`, `test-whatsapp-message`, `create-meta-instance`.

### 8.3 Banco

Migrations em `supabase/migrations/`. Aplicar via CLI/MCP alinhado ao projeto remoto `ijkeuncfyaonjermwggl`.

---

## 9. Testes manuais mínimos

| # | Caso | Resultado esperado |
|---|------|-------------------|
| 1 | Login em produção | Dashboard carrega com projeto correto |
| 2 | Salvar credenciais Meta | `nina_settings` atualizado |
| 3 | Registrar Meta | Instância `official` + `connected` |
| 4 | `test-whatsapp-message` | `success: true` (template se fora 24h) |
| 5 | Webhook Meta | Mensagem inbound cria `messages` / fila Nina |

---

## 10. Referências externas

- [WhatsApp Cloud API — Get Started](https://developers.facebook.com/docs/whatsapp/cloud-api/get-started)
- [Supabase Edge Functions](https://supabase.com/docs/guides/functions)
- [Vite — Env variables](https://vitejs.dev/guide/env-and-mode.html)
