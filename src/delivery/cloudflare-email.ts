import type { AppConfig, Sender } from '../domain/contracts';

interface EmailConfig { emailFrom: string; emailTo: string }
interface EmailBinding { send(message: { from: string; to: string; subject: string; text: string; html: string; headers?: Record<string, string> }): Promise<{ messageId?: string }> }

export function createCloudflareEmailSender(binding: unknown, config: AppConfig & EmailConfig): Sender {
  if (config.delivery.channel !== 'cloudflare_email' || config.emailFrom.trim() === '' || config.emailTo.trim() === '') throw new Error('CONFIG_INVALID:EMAIL');
  if (typeof (binding as Partial<EmailBinding> | null)?.send !== 'function') throw new Error('CONFIG_INVALID:EMAIL_BINDING');
  const email = binding as EmailBinding;
  return {
    async send(payload, attemptId) {
      if (payload.destinationConfigRef !== config.delivery.destinationConfigRef) return { kind: 'suppressed', reason: 'send_disabled' };
      try {
        const result = await email.send({ from: config.emailFrom, to: config.emailTo, subject: payload.subject,
          text: payload.text, html: payload.html, headers: { 'X-Daily-Info-Attempt': attemptId } });
        return { kind: 'accepted', providerMessageId: result.messageId ?? null, acceptedAt: Date.now() };
      } catch {
        return { kind: 'uncertain', code: 'EMAIL_RESPONSE_UNKNOWN' };
      }
    },
  };
}
