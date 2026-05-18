import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

export interface OnboardingStep {
  id: string;
  title: string;
  description: string;
  isComplete: boolean;
  isRequired: boolean;
}

export interface OnboardingStatus {
  loading: boolean;
  isComplete: boolean;
  currentStep: number;
  steps: OnboardingStep[];
  completionPercentage: number;
  hasSeenWizard: boolean;
  isAdmin: boolean;
  refetch: () => Promise<void>;
  markWizardSeen: () => void;
  resetWizard: () => void;
}

const WIZARD_SEEN_KEY = 'onboarding_wizard_seen';

export function useOnboardingStatus(): OnboardingStatus {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const [steps, setSteps] = useState<OnboardingStep[]>([
    {
      id: 'identity',
      title: 'Identidade',
      description: 'Configure o nome da empresa e do agente',
      isComplete: false,
      isRequired: true,
    },
    {
      id: 'whatsapp',
      title: 'Evolution API',
      description: 'Configure a conexão com a Evolution API',
      isComplete: false,
      isRequired: true,
    },
    {
      id: 'whatsapp_connect',
      title: 'Conectar WhatsApp',
      description: 'Crie uma instância e conecte via QR Code',
      isComplete: false,
      isRequired: true,
    },
    {
      id: 'agent',
      title: 'Agente',
      description: 'Configure o prompt e comportamento do agente',
      isComplete: false,
      isRequired: true,
    },
    {
      id: 'elevenlabs',
      title: 'ElevenLabs',
      description: 'Configure respostas em áudio (opcional)',
      isComplete: false,
      isRequired: false,
    },
    {
      id: 'business_hours',
      title: 'Horário',
      description: 'Configure o horário de atendimento',
      isComplete: false,
      isRequired: false,
    },
    {
      id: 'verification',
      title: 'Verificação',
      description: 'Verifique se o sistema está configurado',
      isComplete: false,
      isRequired: false,
    },
    {
      id: 'finish',
      title: 'Finalização',
      description: 'Revise e teste sua configuração',
      isComplete: false,
      isRequired: false,
    },
  ]);
  const [hasSeenWizard, setHasSeenWizard] = useState(() => {
    return localStorage.getItem(WIZARD_SEEN_KEY) === 'true';
  });

  const fetchStatus = useCallback(async () => {
    if (!user) {
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      // Check if user is admin
      const { data: roleData } = await supabase
        .from('user_roles')
        .select('role')
        .eq('user_id', user.id)
        .maybeSingle();
      
      const userIsAdmin = roleData?.role === 'admin';
      setIsAdmin(userIsAdmin);

      // Fetch global nina_settings (no user_id filter)
      const { data: settings } = await supabase
        .from('nina_settings')
        .select('*')
        .limit(1)
        .maybeSingle();

      // Check for connected instance
      const { data: connectedInstances } = await supabase
        .from('whatsapp_instances')
        .select('id')
        .eq('is_active', true)
        .eq('status', 'connected')
        .limit(1);
      const hasConnectedInstance = !!(connectedInstances && connectedInstances.length > 0);

      if (settings) {
        const lsWizard =
          typeof window !== 'undefined' &&
          localStorage.getItem(WIZARD_SEEN_KEY) === 'true';
        const wizardDone =
          !!settings.onboarding_wizard_completed_at || lsWizard;

        setSteps(prev => prev.map(step => {
          switch (step.id) {
            case 'identity':
              return {
                ...step,
                isComplete: !!(settings.company_name && settings.sdr_name),
              };
            case 'whatsapp':
              return {
                ...step,
                isComplete: !!((settings as any).evolution_api_url && (settings as any).evolution_api_key),
              };
            case 'whatsapp_connect':
              return {
                ...step,
                isComplete: hasConnectedInstance,
              };
            case 'agent':
              return {
                ...step,
                isComplete: !!(
                  settings.system_prompt_override?.trim() ||
                  (settings.company_name && settings.sdr_name)
                ),
              };
            case 'elevenlabs':
              return {
                ...step,
                isComplete: !!settings.elevenlabs_api_key,
              };
            case 'business_hours':
              const isDefaultConfig = 
                settings.timezone === 'America/Sao_Paulo' &&
                settings.business_hours_start === '09:00:00' &&
                settings.business_hours_end === '18:00:00' &&
                JSON.stringify(settings.business_days) === '[1,2,3,4,5]';
              return {
                ...step,
                isComplete: !isDefaultConfig || wizardDone,
              };
            case 'verification':
              return {
                ...step,
                isComplete: !!(settings.company_name && settings.sdr_name && (settings as any).evolution_api_url && settings.system_prompt_override),
              };
            case 'finish':
              return {
                ...step,
                isComplete: wizardDone,
              };
            default:
              return step;
          }
        }));

        if (settings.onboarding_wizard_completed_at) {
          setHasSeenWizard(true);
          try {
            localStorage.setItem(WIZARD_SEEN_KEY, 'true');
          } catch {
            /* modo privado / storage indisponível */
          }
        }
      }
    } catch (error) {
      console.error('Error fetching onboarding status:', error);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const markWizardSeen = useCallback(() => {
    localStorage.setItem(WIZARD_SEEN_KEY, 'true');
    setHasSeenWizard(true);
    setSteps(prev => prev.map(step => 
      step.id === 'finish' ? { ...step, isComplete: true } : step
    ));
  }, []);

  const resetWizard = useCallback(() => {
    localStorage.removeItem(WIZARD_SEEN_KEY);
    setHasSeenWizard(false);
    setSteps(prev => prev.map(step => 
      step.id === 'finish' ? { ...step, isComplete: false } : step
    ));
  }, []);

  const requiredSteps = steps.filter(s => s.isRequired);
  const requiredComplete =
    requiredSteps.length > 0 && requiredSteps.every(s => s.isComplete);
  /**
   * Passos que realmente bloqueiam o uso do sistema (não inclui "Conectar WhatsApp",
   * pois o status na tabela whatsapp_instances pode divergir da realidade).
   */
  const CORE_REQUIRED_IDS = ['identity', 'whatsapp', 'agent'] as const;
  const coreComplete = CORE_REQUIRED_IDS.every((id) => {
    const step = steps.find((s) => s.id === id);
    return step?.isComplete;
  });
  /**
   * Oculta o banner se: wizard concluído (localStorage ou coluna no banco), OU
   * identidade + Evolution + agente OK, OU tudo obrigatório (incl. WhatsApp conectado no DB).
   */
  const isComplete =
    hasSeenWizard || coreComplete || requiredComplete;
  const currentStepIndex = steps.findIndex(s => !s.isComplete);
  const completionPercentage = (() => {
    if (isComplete) return 100;
    const req = requiredSteps.length;
    if (!req) return 0;
    const done = requiredSteps.filter(s => s.isComplete).length;
    return Math.round((done / req) * 100);
  })();

  return {
    loading,
    isComplete,
    currentStep: currentStepIndex === -1 ? steps.length - 1 : currentStepIndex,
    steps,
    completionPercentage,
    hasSeenWizard,
    isAdmin,
    refetch: fetchStatus,
    markWizardSeen,
    resetWizard,
  };
}
