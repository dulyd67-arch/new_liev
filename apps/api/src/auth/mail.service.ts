import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import nodemailer, { Transporter } from 'nodemailer';
import { APP_CONFIG, AppConfig } from '../config';

@Injectable()
export class MailService implements OnModuleDestroy {
  private readonly logger = new Logger(MailService.name);
  private readonly transport?: Transporter;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    if (!config.emailEnabled) return;
    this.transport = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpPort === 465,
      requireTLS: config.environment === 'production' && config.smtpPort !== 465,
      auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPassword } : undefined,
      connectionTimeout: 5000,
      greetingTimeout: 5000,
      socketTimeout: 5000,
    });
  }

  async challenge(email: string, kind: 'PASSWORD_RESET' | 'EMAIL_VERIFY', token: string): Promise<boolean> {
    if (!this.transport) return false;
    const path = kind === 'PASSWORD_RESET' ? '/reset-password' : '/verify-email';
    const link = new URL(path, this.config.appPublicUrl);
    // Fragment keeps the token out of ordinary reverse-proxy request logs.
    link.hash = `token=${encodeURIComponent(token)}`;
    try {
      await this.transport.sendMail({
        from: this.config.smtpFrom,
        to: email,
        subject: kind === 'PASSWORD_RESET' ? 'LiveStar password reset' : 'Verify your LiveStar email',
        text: `${kind === 'PASSWORD_RESET' ? 'Reset your password' : 'Verify your email'}: ${link.toString()}\nThis link expires in 30 minutes. If you did not request it, ignore this message.`,
      });
      return true;
    } catch {
      this.logger.warn('Authentication email delivery failed; use the resend endpoint after mail service recovers.');
      return false;
    }
  }

  onModuleDestroy(): void { this.transport?.close(); }
}
