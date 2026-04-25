import nodemailer from 'nodemailer';
import { z } from 'zod';
import { logOutreach, getLeadById } from '../leads/repository.js';
import { leadLogger } from '../utils/logger.js';

const EnvSchema = z.object({
  GMAIL_USER: z.string().email(),
  GMAIL_APP_PASSWORD: z.string().min(1),
});

function getTransport() {
  const env = EnvSchema.parse(process.env);
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: env.GMAIL_USER, pass: env.GMAIL_APP_PASSWORD },
  });
}

export async function sendEmail(leadId: number, toEmail: string): Promise<void> {
  const log = leadLogger(leadId);
  const lead = getLeadById(leadId);

  if (!lead) throw new Error(`Lead ${leadId} not found`);

  const subject = `Quick question about ${lead.name}'s online presence`;
  const body = `Hi there,

I came across ${lead.name} and noticed you don't have a website yet.

I specialize in building simple, affordable websites for local businesses like yours — usually up and running within a week.

Would you be open to a quick 10-minute call to see if it's a fit?

Reply STOP to opt out of future messages.

Best,
[Your Name]`;

  const transport = getTransport();
  const env = EnvSchema.parse(process.env);

  log.info({ to: toEmail }, 'sending email');
  await transport.sendMail({ from: env.GMAIL_USER, to: toEmail, subject, text: body });

  logOutreach({ leadId, zip: lead.zip, phone: lead.phone, channel: 'email', message: body });
  log.info('email sent and logged');
}
