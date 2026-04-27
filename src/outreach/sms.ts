import { execFile } from 'child_process';
import { promisify } from 'util';
import { logOutreach, getLeadById } from '../leads/repository.js';
import { leadLogger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

const ADB = process.env['ADB_PATH'] ??
  (process.platform === 'win32'
    ? `${process.env['LOCALAPPDATA']}\\Android\\Sdk\\platform-tools\\adb.exe`
    : 'adb');

function cityFromLead(address: string, zip: string): string {
  const parts = address.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 3) return parts[parts.length - 2] ?? zip;
  if (parts.length === 2) return parts[0] ?? zip;
  return zip;
}

const TEMPLATES: Record<string, (name: string, location: string) => string> = {
  standard: (name, location) =>
    `Hey, saw ${name} on Google Maps in ${location} — looks like you don't have a website. I build websites and apps. Happy to help if you're interested.`,
  short: (name) =>
    `Hi ${name}, I can build your business a website for a flat fee. Reply YES for details.`,
};

export async function sendSms(leadId: number, template = 'standard', customBody?: string): Promise<void> {
  const log = leadLogger(leadId);
  const lead = await getLeadById(leadId);

  if (!lead) throw new Error(`Lead ${leadId} not found`);
  if (!lead.phone) throw new Error(`Lead ${leadId} has no phone number`);

  const digits = lead.phone.replace(/\D/g, '');
  const e164 = digits.length === 10 ? `+1${digits}` : digits.length === 11 && digits.startsWith('1') ? `+${digits}` : `+${digits}`;

  const location = cityFromLead(lead.address, lead.zip);

  let message: string;
  if (customBody) {
    message = customBody.replace('{name}', lead.name).replace('{location}', location);
  } else {
    const buildMessage = TEMPLATES[template];
    if (!buildMessage) throw new Error(`Unknown template "${template}"`);
    message = buildMessage(lead.name, location);
  }

  const { stdout } = await execFileAsync(ADB, ['devices']);
  const connected = stdout.trim().split('\n').slice(1).filter((l) => l.includes('\tdevice'));
  if (connected.length === 0) throw new Error('No ADB device connected — plug in your Pixel');

  log.info({ to: e164, template }, 'sending SMS via ADB UI automation');

  // Escape single quotes for Android shell: ' → '\''
  const shellMsg = message.replace(/'/g, `'\\''`);
  await execFileAsync(ADB, ['shell',
    `am start -a android.intent.action.SENDTO -d 'smsto:${e164}' --es sms_body '${shellMsg}' --ez exit_on_sent true`,
  ]);

  // Wait for Messages app to load
  await new Promise((r) => setTimeout(r, 3000));

  // Dump UI to find the Send button bounds
  await execFileAsync(ADB, ['shell', 'uiautomator', 'dump', '/sdcard/ui.xml']);
  const { stdout: xml } = await execFileAsync(ADB, ['shell', 'cat', '/sdcard/ui.xml']);

  // Extract Send button coordinates from resource-id="Compose:Draft:Send"
  const match = xml.match(/Compose:Draft:Send[^>]*bounds="?\[(\d+),(\d+)\]\[(\d+),(\d+)\]"?/);
  if (!match) throw new Error('Send button not found in Google Messages UI — is the app open?');

  const cx = Math.round((parseInt(match[1]!) + parseInt(match[3]!)) / 2);
  const cy = Math.round((parseInt(match[2]!) + parseInt(match[4]!)) / 2);

  await execFileAsync(ADB, ['shell', 'input', 'tap', String(cx), String(cy)]);
  await new Promise((r) => setTimeout(r, 1000));

  await logOutreach({ leadId, zip: lead.zip, phone: lead.phone, channel: 'sms', message });
  log.info('SMS sent via ADB');
}
