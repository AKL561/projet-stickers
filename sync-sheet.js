/**
 * sync-sheet.js — Fetch stock from Google Sheet, patch store.json
 * Run: node sync-sheet.js
 * Auto-runs on server startup.
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const SHEET_URL = 'https://docs.google.com/spreadsheets/d/1-cnj1P4-rkT7CCBw4EmqmSpxCJCyFbo6EymsYDoOMVc/export?format=csv&gid=0';
const STORE_PATH = path.join(__dirname, 'store.json');

const CATEGORY_MAP = {
  'S01': 'Stone', 'S02': 'Stone', 'S03': 'Stone', 'S04': 'Stone', 'S05': 'Stone',
  'CP01': 'Cp', 'CP02': 'Cp', 'CP03': 'Cp', 'CP04': 'Cp', 'CP05': 'Cp',
  'YH01': 'Yamaha', 'YH02': 'Yamaha', 'YH03': 'Yamaha', 'YH04': 'Yamaha',
  'YH05': 'Yamaha', 'YH06': 'Yamaha', 'YH07': 'Yamaha',
  'AR01': 'Arai', 'AR02': 'Arai', 'AR03': 'Arai', 'AR04': 'Arai',
  'AR05': 'Arai', 'AR06': 'Arai', 'AR07': 'Arai',
  'KT01': 'KTM',
  'M1': 'OM', 'M2': 'OM',
  'PG01': 'PSG',
  'RL01': 'Real',
  'GT01': 'Gaston', 'GT02': 'Gaston', 'GT03': 'Gaston', 'GT04': 'Gaston',
  'GT05': 'Gaston', 'GT06': 'Gaston', 'GT07': 'Gaston', 'GT08': 'Gaston',
  'J01': 'Jul', 'J02': 'Jul', 'J03': 'Jul', 'J04': 'Jul', 'J05': 'Jul', 'J06': 'Jul',
  'OV01': 'Ovni', 'OV02': 'Ovni', 'OV03': 'Ovni',
  'DR01': 'Dorure', 'CL01': 'Cagoule', 'CL02': 'Cagoule',
  'BP01': 'Bape', 'NT01': 'Ntd', 'PL01': 'Philippe',
  'VR01': 'Vrunk', 'OT01': 'Omerta',
  'P01': 'Paul', 'P02': 'Paul', 'P03': 'Paul', 'P04': 'Paul',
  'P05': 'Paul', 'P06': 'Paul', 'P07': 'Paul', 'P08': 'Paul',
  'FZ01': 'Freezer',
  'SM02': 'Simpson', 'SM1': 'Simpson',
  'TN01': 'TN',
  'EY01': 'Eye',
  'FR01': 'France', 'FR02': 'France',
  'IT01': 'Italie',
  'ES01': 'Espagne',
  'C01': 'Corse',
  'SN01': 'Senegal',
  'RC01': 'Congo',
  'AL01': 'Algerie',
  'TS01': 'Tunisie',
  'MR01': 'Maroc',
  'DZ01': 'Dz',
  'PT01': 'Portugal',
  'BZ01': 'Bresil',
  'P1': 'Palestine',
  'AM01': 'Amazigh',
  'G81': 'Gitans',
  'R1': 'Morti',
  '01P': 'Porte-cle', '02P': 'Porte-cle',
  'ZN01': 'Zone',
  'A461': '46',
};

function guessCategory(qrCode) {
  const key = qrCode.trim();
  if (CATEGORY_MAP[key]) return CATEGORY_MAP[key];
  // Try partial match (e.g. AR for Arai)
  for (const [prefix, cat] of Object.entries(CATEGORY_MAP)) {
    if (key.startsWith(prefix)) return cat;
  }
  return 'Sticker';
}

function fetchURL(url, redirects = 0) {
  if (redirects > 5) throw new Error('Too many redirects');
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { timeout: 15000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = res.headers.location;
        fetchURL(loc.startsWith('http') ? loc : new URL(loc, url).href, redirects + 1)
          .then(resolve).catch(reject);
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('Timeout')); });
  });
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

function parseCSV(text) {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = parseCSVLine(lines[0]).map(h => h.trim().replace(/^"|"$/g, ''));

  const titleIdx = headers.indexOf('Titre');
  const qrIdx = headers.indexOf('QR code');
  const stockIdx = headers.indexOf('Totale');
  if (qrIdx === -1 || stockIdx === -1) {
    console.error(`CSV headers mismatch. Found: ${headers}`);
    return [];
  }
  const products = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    const qr = (cols[qrIdx] || '').trim();
    const title = titleIdx >= 0 ? (cols[titleIdx] || '').trim() : '';
    const stockStr = (cols[stockIdx] || '').trim();
    const stock = parseInt(stockStr, 10) || 0;
    if (!qr) continue;
    products.push({ qr, title, stock });
  }
  return products;
}

async function sync() {
  console.log('🔄 Syncing stock from Google Sheet...');
  const csvText = await fetchURL(SHEET_URL);
  const sheetProducts = parseCSV(csvText);
  console.log(`  → ${sheetProducts.length} products from sheet`);

  let store = { products: [], orders: [] };
  if (fs.existsSync(STORE_PATH)) {
    try {
      store = JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
    } catch(e) {
      console.log('  ⚠️ store.json parse error, starting fresh');
      store = { products: [], orders: [] };
    }
  }
  if (!store.orders) store.orders = [];
  if (!store.products) store.products = [];

  const storeMap = new Map();
  let maxId = 0;
  for (const p of store.products) {
    storeMap.set(p.name.trim().toLowerCase(), p);
    if (p.id && p.id > maxId) maxId = p.id;
  }

  let updated = 0;
  let added = 0;
  const seenNames = new Set();

  for (const sp of sheetProducts) {
    const key = sp.qr.trim().toLowerCase();
    seenNames.add(key);

    if (storeMap.has(key)) {
      const existing = storeMap.get(key);
      if (existing.stock !== sp.stock) {
        existing.stock = sp.stock;
        updated++;
      }
    } else {
      maxId++;
      const qr = sp.qr.trim();
      store.products.push({
        id: maxId,
        name: qr,
        stock: sp.stock,
        category: guessCategory(qr),
        image: `stickers/${qr}.jpeg`,
        title: sp.title || qr
      });
      added++;
    }
  }

  // Remove stale products
  const before = store.products.length;
  const removedNames = [];
  store.products = store.products.filter(p => {
    const key = p.name.trim().toLowerCase();
    if (seenNames.has(key)) return true;
    removedNames.push(p.name);
    return false;
  });
  const removed = removedNames.length;
  if (removed > 0) console.log(`  🗑️ Removed stale: ${removedNames.join(', ')}`);

  store.meta = { lastSync: new Date().toISOString() };

  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), 'utf-8');

  console.log(`  ✅ Stock batch: ${updated} updated, ${added} added, ${removed} removed`);
  console.log(`  📦 Total: ${store.products.length} products`);

  return store;
}

if (require.main === module) {
  sync().catch(err => {
    console.error('❌ Sync failed:', err.message);
    process.exit(1);
  });
}

module.exports = { sync, guessCategory };