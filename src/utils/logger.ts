import pino from 'pino';

export const logger = pino({
  transport: {
    target: 'pino-pretty',
    options: { colorize: true, translateTime: 'SYS:standard' },
  },
});

export function leadLogger(leadId: number | string) {
  return logger.child({ leadId });
}
