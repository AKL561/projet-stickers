/**
 * sheetService.js — Write stock back to Google Sheet
 * Uses the service account key to authenticate and update the "Totale" column.
 */

const { google } = require('googleapis');
const path = require('path');

const SHEET_ID = '1-cnj1P4-rkT7CCBw4EmqmSpxCJCyFbo6EymsYDoOMVc';
const KEY_PATH = path.join(__dirname, 'service-account-key.json');

const COL_QR = 1;   // B = QR code
const COL_STOCK = 2; // C = Totale
const HEADER_ROW = 1; // Row 1 is header (Titre | QR code | Totale)
const FIRST_DATA_ROW = 2;

let auth = null;
let sheets = null;

/**
 * Initialise le client Google Sheets.
 * Priorité : GOOGLE_CREDENTIALS_JSON (env) → fichier service-account-key.json (local)
 */
async function getSheetsClient() {
  if (sheets) return sheets;

  const envJson = process.env.GOOGLE_CREDENTIALS_JSON;
  if (envJson) {
    // Render / production : credentials passées via variable d'environnement
    const credentials = JSON.parse(envJson);
    auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    console.log('  🔑 Authentifié via GOOGLE_CREDENTIALS_JSON');
  } else {
    // Local : fichier service-account-key.json
    auth = new google.auth.GoogleAuth({
      keyFile: KEY_PATH,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    console.log('  🔑 Authentifié via fichier local');
  }

  sheets = google.sheets({ version: 'v4', auth });
  return sheets;
}

/**
 * Update Google Sheet stock for a single product.
 * Finds the row by QR code, updates the Totale column.
 */
async function updateStockInSheet(qrCode, newStock) {
  try {
    const client = await getSheetsClient();

    // Read existing data to find the row index
    const range = `A2:C`;
    const response = await client.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range,
    });

    const rows = response.data.values || [];
    let rowIndex = -1;
    const qrClean = qrCode.trim().toLowerCase();

    for (let i = 0; i < rows.length; i++) {
      const rowQr = (rows[i][COL_QR] || '').trim().toLowerCase();
      if (rowQr === qrClean) {
        rowIndex = FIRST_DATA_ROW + i;
        break;
      }
    }

    if (rowIndex === -1) {
      console.log(`  ⚠️ Product ${qrCode} not found in sheet, skipping write`);
      return false;
    }

    // Update the stock cell
    const updateRange = `C${rowIndex}`;
    await client.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: updateRange,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[newStock]] },
    });

    console.log(`  📝 Sheet updated: ${qrCode} → stock=${newStock} (row ${rowIndex})`);
    return true;
  } catch (err) {
    console.error(`  ❌ Sheet write error for ${qrCode}:`, err.message);
    return false;
  }
}

/**
 * Batch update Google Sheet stock for multiple products.
 * More efficient than individual calls.
 */
async function batchUpdateStockInSheet(updates) {
  if (updates.length === 0) return;

  try {
    const client = await getSheetsClient();

    // Read existing data to build row index mapping
    const range = `A2:C`;
    const response = await client.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range,
    });

    const rows = response.data.values || [];
    const qrToRow = new Map();

    for (let i = 0; i < rows.length; i++) {
      const rowQr = (rows[i][COL_QR] || '').trim().toLowerCase();
      if (rowQr) {
        qrToRow.set(rowQr, FIRST_DATA_ROW + i);
      }
    }

    // Build batch update requests
    const data = [];
    for (const { qrCode, newStock } of updates) {
      const rowIndex = qrToRow.get(qrCode.trim().toLowerCase());
      if (rowIndex) {
        data.push({
          range: `C${rowIndex}`,
          values: [[newStock]],
        });
      } else {
        console.log(`  ⚠️ ${qrCode} not found in sheet, skipping`);
      }
    }

    if (data.length === 0) {
      console.log('  ℹ️ No sheet updates to apply');
      return;
    }

    await client.spreadsheets.values.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { data, valueInputOption: 'USER_ENTERED' },
    });

    console.log(`  ✅ Batch sheet update: ${data.length} products updated`);
  } catch (err) {
    console.error('  ❌ Batch sheet write error:', err.message);
  }
}

module.exports = { updateStockInSheet, batchUpdateStockInSheet };