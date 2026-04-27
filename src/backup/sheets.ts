import { google } from 'googleapis';
import { getAllLeads } from '../leads/repository.js';

function getAuth() {
  const keyJson = process.env['GOOGLE_SERVICE_ACCOUNT_JSON'];
  if (!keyJson) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set in .env');
  let key: { client_email: string; private_key: string };
  try {
    key = JSON.parse(keyJson);
  } catch {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON');
  }
  const privateKey = key.private_key.replace(/\\n/g, '\n');
  return new google.auth.GoogleAuth({
    credentials: { client_email: key.client_email, private_key: privateKey },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

export async function backupToSheets(): Promise<{ url: string; rows: number }> {
  const sheetId = process.env['GOOGLE_SHEET_ID'];
  if (!sheetId || sheetId === 'PASTE_YOUR_SHEET_ID_HERE') {
    throw new Error('GOOGLE_SHEET_ID is not set in .env');
  }

  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  // Get actual first sheet tab name (don't assume "Sheet1")
  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  const sheetTitle = meta.data.sheets?.[0]?.properties?.title ?? 'Sheet1';

  const leads = await getAllLeads();

  if (leads.length === 0) {
    throw new Error('No leads to export — scrape some leads first');
  }

  const headers = [
    'ID', 'Name', 'Phone', 'Address', 'Category', 'ZIP',
    'Rating', 'Reviews', 'Has Website', 'Website URL',
    'Website Emails', 'Website Phones', 'Maps URL', 'Created At', 'Updated At',
  ];

  const rows = leads.map((l) => [
    String(l.id ?? ''),
    l.name ?? '',
    l.phone ?? '',
    l.address ?? '',
    l.category ?? '',
    l.zip ?? '',
    l.rating != null ? String(l.rating) : '',
    l.review_count != null ? String(l.review_count) : '',
    l.has_website ? 'Yes' : 'No',
    l.website_url ?? '',
    (() => { try { return (JSON.parse(l.website_emails || '[]') as string[]).join(', '); } catch { return ''; } })(),
    (() => { try { return (JSON.parse(l.website_phones || '[]') as string[]).join(', '); } catch { return ''; } })(),
    l.maps_url ?? '',
    l.created_at ?? '',
    l.updated_at ?? '',
  ]);

  await sheets.spreadsheets.values.clear({ spreadsheetId: sheetId, range: sheetTitle });

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${sheetTitle}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [headers, ...rows] },
  });

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: [{
        repeatCell: {
          range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1 },
          cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.2, green: 0.5, blue: 0.3 } } },
          fields: 'userEnteredFormat(textFormat,backgroundColor)',
        },
      }],
    },
  });

  return { url: `https://docs.google.com/spreadsheets/d/${sheetId}`, rows: rows.length };
}
