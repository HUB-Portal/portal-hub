import { createTransport, type Transporter } from 'nodemailer';
import { config } from '../config';
import { SYSTEM, tx } from '../db';
import { registerJob } from '../jobs';

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
}

let transport: Transporter | undefined;

/** Sends through SMTP when SMTP_URL is set, otherwise stores the message in dev_mailbox (development only). */
export async function sendMail(m: OutgoingMail): Promise<void> {
  if (config.smtpUrl) {
    transport ??= createTransport(config.smtpUrl);
    await transport.sendMail({ from: config.mailFrom, to: m.to, subject: m.subject, text: m.text });
    return;
  }
  if (config.isProd) throw new Error('SMTP_URL is not configured');
  await tx(SYSTEM, (c) => c.query('INSERT INTO dev_mailbox (to_addr, subject, body) VALUES ($1, $2, $3)', [m.to, m.subject, m.text]));
}

export type EmailTemplate =
  | 'invite'
  | 'password_reset'
  | 'notice'
  | 'signup_confirm'
  | 'signup_existing'
  | 'signup_declined'
  | 'signup_approved'
  | 'admin_new_signup'
  | 'admin_signup_ceiling';

/** Subject of the registration confirmation email (the demo registrations route finds these in the dev mailbox). */
export const SIGNUP_CONFIRM_SUBJECT = 'Confirm your email address for the Portal Hub';

const support = () => `Questions? Write to ${config.supportEmail}.`;

/** Plain British English. No patient data in any template. */
export function renderEmail(template: EmailTemplate, data: Record<string, any>): { subject: string; text: string } {
  const name = typeof data.name === 'string' && data.name ? data.name : 'there';
  switch (template) {
    case 'invite':
      return {
        subject: 'You are invited to the Portal Hub',
        text: [
          `Hello ${name},`,
          '',
          `${data.inviter ?? 'A colleague'} has invited you to join ${data.orgName ?? 'the Portal Hub'}.`,
          '',
          'Choose your password here. The link works once and expires in 7 days.',
          String(data.link),
          '',
          'You will then set up an authenticator app, which is needed every time you sign in.',
          '',
          support(),
        ].join('\n'),
      };
    case 'password_reset':
      return {
        subject: 'Reset your Portal Hub password',
        text: [
          `Hello ${name},`,
          '',
          'We received a request to reset your password. Use this link within 60 minutes. It works once.',
          String(data.link),
          '',
          'You will still need your authenticator app to sign in. If you did not ask for this, you can ignore this email.',
          '',
          support(),
        ].join('\n'),
      };
    // Registration emails have fixed text. Nothing the registrant typed (company, name) is ever put into them.
    case 'signup_confirm':
      return {
        subject: SIGNUP_CONFIRM_SUBJECT,
        text: [
          'Hello,',
          '',
          'Someone asked to register a company on the Portal Hub with this email address.',
          '',
          'To continue, confirm your email address and choose a password. The link works once and expires in 48 hours.',
          String(data.link),
          '',
          'You will then set up an authenticator app, which is needed every time you sign in. After that, K Line reviews the registration before your company can send cases.',
          '',
          'If this was not you, you can ignore this email. Nothing happens unless the link is used.',
          '',
          support(),
        ].join('\n'),
      };
    case 'signup_existing':
      return {
        subject: 'You already have a Portal Hub account',
        text: [
          'Hello,',
          '',
          'Someone tried to register a company on the Portal Hub with this email address. There is already an account for it, so nothing new was created.',
          '',
          'To sign in, go to:',
          String(data.link),
          '',
          'If you forgot your password, use the link on the sign in page to reset it.',
          '',
          'If this was not you, you can ignore this email.',
          '',
          support(),
        ].join('\n'),
      };
    case 'signup_declined':
      return {
        subject: 'Your Portal Hub registration',
        text: [
          'Hello,',
          '',
          'K Line has reviewed the registration made with this email address and could not approve it. The registration and the account details will be deleted from our systems within 30 days.',
          '',
          `If you think this is a mistake, write to ${config.supportEmail}.`,
        ].join('\n'),
      };
    case 'signup_approved':
      return {
        subject: 'Your company is approved on the Portal Hub',
        text: [
          'Hello,',
          '',
          'Good news. K Line has approved your company. You can now send cases, add your team and use every feature of the Portal Hub.',
          '',
          'Sign in here:',
          String(data.link),
          '',
          support(),
        ].join('\n'),
      };
    case 'admin_new_signup':
      return {
        subject: 'A new company is waiting for review',
        text: [
          'Hello,',
          '',
          'A new company has confirmed its email address and is waiting for review on the Portal Hub.',
          '',
          'Open the review list:',
          String(data.link),
        ].join('\n'),
      };
    case 'admin_signup_ceiling':
      return {
        subject: 'The daily registration limit has been reached',
        text: [
          'Hello,',
          '',
          'The daily limit for new company registrations on the Portal Hub has been reached. Further registration attempts are not being processed until the count drops again. This notice is sent at most once a day.',
          '',
          'If this looks unusual, check the audit log and the registration list:',
          String(data.link),
        ].join('\n'),
      };
    default:
      return { subject: String(data.subject ?? 'Portal Hub'), text: String(data.text ?? '') };
  }
}

registerJob('email.send', async (job) => {
  const { to, template, data } = job.payload as { to: string; template: EmailTemplate; data: Record<string, any> };
  const { subject, text } = renderEmail(template, data ?? {});
  await sendMail({ to, subject, text });
});
