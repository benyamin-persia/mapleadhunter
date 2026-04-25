import { Command } from 'commander';
import { getAllLeads } from '../../leads/repository.js';
import { logger } from '../../utils/logger.js';
import fs from 'fs';
import path from 'path';

export const exportLeadsCommand = new Command('export-leads')
  .description('Export all leads to leads.csv')
  .option('--out <path>', 'Output file path', 'leads.csv')
  .action(async (opts: { out: string }) => {
    const leads = getAllLeads();

    if (leads.length === 0) {
      logger.warn('No leads found — run scrape first');
      return;
    }

    const headers = ['id', 'name', 'address', 'phone', 'category', 'rating', 'zip', 'maps_url', 'created_at'];
    const rows = leads.map((l) =>
      [l.id, l.name, l.address, l.phone, l.category, l.rating ?? '', l.zip, l.maps_url, l.created_at]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(','),
    );

    const csv = [headers.join(','), ...rows].join('\n');
    const outPath = path.resolve(opts.out);
    fs.writeFileSync(outPath, csv, 'utf8');

    logger.info({ path: outPath, count: leads.length }, 'exported leads');
  });
