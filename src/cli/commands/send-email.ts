import { Command } from 'commander';
import { z } from 'zod';
import { sendEmail } from '../../outreach/email.js';
import { logger } from '../../utils/logger.js';

const ArgsSchema = z.object({
  leadId: z.coerce.number().int().positive(),
  to: z.string().email(),
});

export const sendEmailCommand = new Command('send-email')
  .description('Send email to a lead')
  .requiredOption('--lead-id <id>', 'Lead ID from the database')
  .requiredOption('--to <email>', 'Recipient email address')
  .action(async (opts: unknown) => {
    const args = ArgsSchema.parse(opts);
    try {
      await sendEmail(args.leadId, args.to);
    } catch (err) {
      logger.error({ err }, 'Email failed');
      process.exit(1);
    }
  });
