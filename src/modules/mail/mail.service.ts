import { MailerService } from '@nestjs-modules/mailer';
import { Injectable, InternalServerErrorException } from '@nestjs/common';

@Injectable()
export class MailService {
  constructor(private mailerService: MailerService) {}

  async sendVerificationEmail({
    email,
    firstName,
    url,
  }: {
    email: string;
    firstName: string;
    url: string;
  }) {
    try {
      await this.mailerService.sendMail({
        to: email,
        subject: 'Verify your Kravinqs account',
        template: 'verify-email',
        context: { firstName, url, year: new Date().getFullYear() },
      });
    } catch (error) {
      console.error('Verification email failed:', error);
      throw new InternalServerErrorException(
        'Failed to send verification email',
      );
    }
  }

  async sendForgotPasswordEmail({
    email,
    firstName,
    url,
  }: {
    email: string;
    firstName: string;
    url: string;
  }) {
    try {
      await this.mailerService.sendMail({
        to: email,
        subject: 'Reset your Kravinqs password',
        template: 'forgot-password',
        context: { firstName, url, year: new Date().getFullYear() },
      });
    } catch (error) {
      console.error('Forgot password email failed:', error);
      throw new InternalServerErrorException(
        'Failed to send password reset email',
      );
    }
  }

  async sendWelcomeEmail({
    email,
    firstName,
  }: {
    email: string;
    firstName: string;
  }) {
    try {
      await this.mailerService.sendMail({
        to: email,
        subject: 'Welcome to Kravinqs! 🍔',
        template: 'welcome',
        context: { firstName, year: new Date().getFullYear() },
      });
    } catch (error) {
      console.error('Welcome email failed:', error);
      throw new InternalServerErrorException('Failed to send welcome email');
    }
  }
}
