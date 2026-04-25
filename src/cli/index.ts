import 'dotenv/config';
import { Command } from 'commander';
import { scrapeCommand } from './commands/scrape.js';
import { exportLeadsCommand } from './commands/export-leads.js';
import { sendSmsCommand } from './commands/send-sms.js';
import { sendEmailCommand } from './commands/send-email.js';

const program = new Command()
  .name('mapleadhunter')
  .description('Scrape no-website businesses from Google Maps and send outreach')
  .version('1.0.0');

program.addCommand(scrapeCommand);
program.addCommand(exportLeadsCommand);
program.addCommand(sendSmsCommand);
program.addCommand(sendEmailCommand);

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
