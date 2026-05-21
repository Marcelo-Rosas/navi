import React, { useState } from 'react';
import { Loader2, CheckCircle, Smartphone, AlertTriangle, Cloud } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { parseFunctionError } from '@/lib/parseFunctionError';

interface AddInstanceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  metaConfigured?: boolean;
  whatsappAccessToken?: string | null;
  whatsappPhoneNumberId?: string | null;
}

type Step = 'credentials' | 'creating' | 'connected';

export function AddInstanceDialog({
  open,
  onOpenChange,
  metaConfigured = false,
  whatsappAccessToken,
  whatsappPhoneNumberId,
}: AddInstanceDialogProps) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>('credentials');
  const [name, setName] = useState('');
  const [isDefault, setIsDefault] = useState(true);
  const [isCreating, setIsCreating] = useState(false);

  const handleClose = () => {
    setStep('credentials');
    setName('');
    setIsDefault(true);
    onOpenChange(false);
  };

  const handleRegister = async () => {
    if (!name.trim()) {
      toast.error('Informe o nome da conexão');
      return;
    }
    if (!metaConfigured) {
      toast.error('Configure Access Token e Phone Number ID (Meta) acima e salve');
      return;
    }

    setIsCreating(true);
    setStep('creating');

    try {
      const { data, error } = await supabase.functions.invoke('create-meta-instance', {
        body: {
          name: name.trim(),
          is_default: isDefault,
          whatsapp_access_token: whatsappAccessToken,
          whatsapp_phone_number_id: whatsappPhoneNumberId,
        },
      });

      if (error) {
        throw new Error(await parseFunctionError(error, data));
      }
      if (!data?.success) {
        throw new Error(data?.error || 'Falha ao registrar');
      }

      queryClient.invalidateQueries({ queryKey: ['whatsapp-instances'] });
      setStep('connected');
      toast.success('WhatsApp Cloud API registrado');
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Erro desconhecido');
      setStep('credentials');
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Registrar WhatsApp Cloud API</DialogTitle>
          <DialogDescription>
            Meta Cloud API — sem QR Code. Evolution API está deprecada (ver REQUIREMENTS.md).
          </DialogDescription>
        </DialogHeader>

        {step === 'credentials' && (
          <div className="space-y-4 mt-2">
            {!metaConfigured ? (
              <div className="flex items-start gap-2 p-3 rounded-lg border border-amber-500/30 bg-amber-500/5">
                <AlertTriangle className="w-4 h-4 mt-0.5 text-amber-600 shrink-0" />
                <p className="text-xs text-muted-foreground">
                  Preencha e salve <strong>Access Token</strong> e <strong>Phone Number ID</strong> na seção Meta
                  acima antes de registrar.
                </p>
              </div>
            ) : (
              <div className="flex items-center gap-2 p-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5">
                <Cloud className="w-4 h-4 text-emerald-600 shrink-0" />
                <p className="text-xs text-muted-foreground">
                  Phone Number ID: <span className="font-mono text-foreground">{whatsappPhoneNumberId}</span>
                </p>
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="connName">Nome da conexão</Label>
              <Input
                id="connName"
                placeholder="Ex: WhatsApp Vectra Cargo"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={!metaConfigured}
              />
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="isDefault"
                checked={isDefault}
                onChange={(e) => setIsDefault(e.target.checked)}
                disabled={!metaConfigured}
                className="w-4 h-4 accent-primary"
              />
              <Label htmlFor="isDefault" className="font-normal cursor-pointer">
                Conexão padrão
              </Label>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={handleClose}>
                Cancelar
              </Button>
              <Button onClick={handleRegister} disabled={!metaConfigured} className="gap-2">
                <Cloud className="w-4 h-4" />
                Registrar Meta
              </Button>
            </div>
          </div>
        )}

        {step === 'creating' && (
          <div className="flex flex-col items-center py-10 gap-3">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">Registrando na NAVI...</p>
          </div>
        )}

        {step === 'connected' && (
          <div className="flex flex-col items-center py-10 gap-4">
            <CheckCircle className="w-10 h-10 text-emerald-500" />
            <p className="font-semibold">{name}</p>
            <p className="text-sm text-muted-foreground text-center">Pronto para envio e recebimento via Meta.</p>
            <Button onClick={handleClose} className="gap-2">
              <Smartphone className="w-4 h-4" />
              Concluir
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
