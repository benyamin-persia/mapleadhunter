import { Command } from 'commander';
import { z } from 'zod';
import fs from 'fs';
import csvParser from 'csv-parser';
import { scrapeZip } from '../../scraper/map-scraper.js';
import { insertLeads } from '../../leads/repository.js';
import { logger } from '../../utils/logger.js';
import { randomDelay } from '../../utils/delays.js';

const ArgsSchema = z.object({
  zips: z.string().optional(),
  zipsFile: z.string().optional(),
  category: z.string().min(1),
});

async function readZipsFromFile(filePath: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const zips: string[] = [];
    fs.createReadStream(filePath)
      .pipe(csvParser())
      .on('data', (row: Record<string, string>) => {
        const zip = row['zip'] ?? row['ZIP'] ?? Object.values(row)[0];
        if (zip) zips.push(zip.trim());
      })
      .on('end', () => resolve(zips))
      .on('error', reject);
  });
}

export const scrapeCommand = new Command('scrape')
  .description('Scrape Google Maps for no-website businesses')
  .option('--zips <zips>', 'Comma-separated zip codes, e.g. 90210,33101')
  .option('--zips-file <file>', 'Path to CSV file with a "zip" column')
  .requiredOption('--category <category>', 'Business category to search, e.g. restaurant')
  .action(async (opts: unknown) => {
    const args = ArgsSchema.parse(opts);

    let zips: string[] = [];

    if (args.zips) {
      zips = args.zips.split(',').map((z) => z.trim());
    } else if (args.zipsFile) {
      zips = await readZipsFromFile(args.zipsFile);
    } else {
      logger.error('Provide --zips or --zips-file');
      process.exit(1);
    }

    logger.info({ zips: zips.length, category: args.category }, 'starting scrape');

    for (const zip of zips) {
      const { leads } = await scrapeZip(zip, args.category);
      if (leads.length > 0) insertLeads(leads);
      await randomDelay(); // between zips
    }

    logger.info('all zips done — run `npm run export-leads` to get CSV');
  });
