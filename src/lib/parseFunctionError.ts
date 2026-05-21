/** Extrai mensagem legível de erros do supabase.functions.invoke */
export async function parseFunctionError(
  error: unknown,
  data?: { error?: string; success?: boolean } | null,
): Promise<string> {
  if (data?.error) return data.error;

  const fnError = error as { context?: Response; message?: string };
  if (fnError?.context) {
    try {
      const body = await fnError.context.json();
      if (body?.error && typeof body.error === 'string') return body.error;
    } catch {
      /* response já consumida ou não é JSON */
    }
  }

  if (error instanceof Error && error.message) {
    return error.message.replace(/^Edge Function returned a non-2xx status code\s*/i, '').trim()
      || error.message;
  }

  return 'Erro ao chamar a função';
}
