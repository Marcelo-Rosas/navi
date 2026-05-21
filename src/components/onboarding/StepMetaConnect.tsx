import React, { useState, useEffect, useCallback } from 'react';
import { Cloud, Loader2, CheckCircle, Plus, AlertTriangle } from 'lucide-react';
import { motion } from 'framer-motion';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/Button';
import { supabase } from '@/integrations/supabase/client';
import { parseFunctionError } from '@/lib/parseFunctionError';
import { toast } from 'sonner';

interface StepMetaConnectProps {
  accessToken: string;
  phoneNumberId: string;
  onInstanceConnected?: () => void;
}

export const StepMetaConnect: React.FC<StepMetaConnectProps> = ({
  accessToken,
  phoneNumberId,
  onInstanceConnected,
}) => {
  const [displayName, setDisplayName] = useState('WhatsApp Vectra');
  const [isRegistering, setIsRegistering] = useState(false);
  const [connected, setConnected] = useState(false);
  const [connectedLabel, setConnectedLabel] = useState('');

  const metaReady = !!(accessToken?.trim() && phoneNumberId?.trim());

  const checkExisting = useCallback(async () => {
    const { data } = await supabase
      .from('whatsapp_instances')
      .select('id, name, status, phone_number, provider_type')
      .eq('is_active', true)
      .eq('provider_type', 'official')
      .eq('status', 'connected')
      .limit(1);

    if (data?.length) {
      setConnected(true);
      setConnectedLabel(data[0].phone_number || data[0].name);
      onInstanceConnected?.();
    }
  }, [onInstanceConnected]);

  useEffect(() => {
    checkExisting();
  }, [checkExisting]);

  const handleRegister = async () => {
    if (!metaReady) {
      toast.error('Preencha Access Token e Phone Number ID no passo anterior');
      return;
    }

    setIsRegistering(true);
    try {
      const { data, error } = await supabase.functions.invoke('create-meta-instance', {
        body: {
          name: displayName.trim() || 'WhatsApp Cloud API',
          is_default: true,
          whatsapp_access_token: accessToken.trim(),
          whatsapp_phone_number_id: phoneNumberId.trim(),
        },
      });

      if (error) {
        throw new Error(await parseFunctionError(error, data));
      }
      if (!data?.success) {
        throw new Error(data?.error || 'Falha ao registrar instância');
      }

      setConnected(true);
      setConnectedLabel(data.display_phone_number || data.verified_name || displayName);
      toast.success('WhatsApp Cloud API registrado na NAVI');
      onInstanceConnected?.();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erro ao registrar';
      toast.error(msg);
    } finally {
      setIsRegistering(false);
    }
  };

  if (!metaReady) {
    return (
      <div className="flex flex-col items-center gap-4 py-8 text-center max-w-md mx-auto">
        <AlertTriangle className="w-10 h-10 text-amber-500" />
        <p className="text-sm text-muted-foreground">
          Volte ao passo anterior e informe o <strong>Access Token</strong> e o{' '}
          <strong>Phone Number ID</strong> da Meta Cloud API.
        </p>
      </div>
    );
  }

  if (connected) {
    return (
      <motion.div
        className="flex flex-col items-center gap-4 py-10"
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
      >
        <div className="w-20 h-20 rounded-full bg-emerald-500/10 flex items-center justify-center border-2 border-emerald-500/30">
          <CheckCircle className="w-10 h-10 text-emerald-500" />
        </div>
        <div className="text-center">
          <p className="font-semibold text-lg text-foreground">WhatsApp Cloud API conectado</p>
          {connectedLabel && (
            <p className="text-sm text-muted-foreground mt-1">{connectedLabel}</p>
          )}
        </div>
        <p className="text-xs text-muted-foreground max-w-sm text-center">
          Não é necessário QR Code. Mensagens saem pela API oficial da Meta usando as credenciais
          salvas em Configurações.
        </p>
      </motion.div>
    );
  }

  return (
    <div className="space-y-6 max-w-md mx-auto">
      <div className="text-center">
        <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center">
          <Cloud className="w-8 h-8 text-emerald-500" />
        </div>
        <h3 className="text-xl font-semibold text-foreground mb-2">Registrar na NAVI</h3>
        <p className="text-sm text-muted-foreground">
          Com a Meta Cloud API não há instância Evolution nem QR Code. Registre o número oficial
          para aparecer no painel e nos relatórios.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="metaDisplayName">Nome da conexão</Label>
        <Input
          id="metaDisplayName"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="Ex: WhatsApp Vectra Cargo"
        />
      </div>

      <Button
        onClick={handleRegister}
        disabled={isRegistering}
        className="w-full gap-2"
      >
        {isRegistering ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <Plus className="w-4 h-4" />
        )}
        {isRegistering ? 'Registrando...' : 'Registrar WhatsApp Cloud API'}
      </Button>

      <p className="text-xs text-muted-foreground text-center">
        Lembre de adicionar números de teste em Meta for Developers → WhatsApp → API Setup → To,
        se estiver em modo desenvolvimento.
      </p>
    </div>
  );
};
