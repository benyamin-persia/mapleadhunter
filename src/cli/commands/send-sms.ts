import { Command } from 'commander';
import { z } from 'zod';
import { sendSms } from '../../outreach/sms.js';
import { logger } from '../../utils/logger.js';

const ArgsSchema = z.object({
  leadId: z.coerce.number().int().positive(),
  template: z.string().default('standard'),
});

export const sendSmsCommand = new Command('send-sms')
  .description('Send SMS to a lead')
  .requiredOption('--lead-id <id>', 'Lead ID from the database')
  .option('--template <name>', 'Message template name', 'standard')
  .action(async (opts: unknown) => {
    const args = ArgsSchema.parse(opts);
    try {
      await sendSms(args.leadId, args.template);
    } catch (err) {
      logger.error({ err }, 'SMS failed');
      process.exit(1);
    }
  });
