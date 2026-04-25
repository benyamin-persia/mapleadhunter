import { logger } from './logger.js';

const MIN_MS = Number(process.env['SCRAPE_MIN_DELAY_MS'] ?? 4000);
const MAX_MS = Number(process.env['SCRAPE_MAX_DELAY_MS'] ?? 12000);

export async function randomDelay(min = MIN_MS, max = MAX_MS): Promise<void> {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  logger.debug({ ms }, 'random delay');
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function shortDelay(): Promise<void> {
  await randomDelay(1500, 3000);
}
