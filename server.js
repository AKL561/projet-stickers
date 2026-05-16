// ═══════════════════════════════════════════════════════════════
// Vinted Automation Backend v2.0
// ────────────────────────────────────────────────────────────
// Connexion IMAP Yahoo → Parsing emails Vinted (ACHAT, paiement,
// expédition) → Stock tracking → Données prêtes pour facture
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const Imap = require('imap');
const { simpleParser } = require('mailparser');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const { sync } = require('./sync-sheet');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Data store ────────────────────────────────────────────────
const DATA_FILE = path.join(__dirname, 'store.json');

function loadStore() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Erreur chargement store:', e.message);
  }
  return { orders: [], products: [], meta: { lastSync: null } };
}

function saveStore(store) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
  } catch (e) {
    console.error('Erreur sauvegarde store:', e.message);
  }
}

// ── Reservation Helpers ──────────────────────────────────────
const RESERVATIONS_FILE = path.join(__dirname, 'reservations.json');

function loadReservations() {
  try { return JSON.parse(fs.readFileSync(RESERVATIONS_FILE, 'utf8')); }
  catch { return []; }
}

function saveReservations(data) {
  fs.writeFileSync(RESERVATIONS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// Auto-confirm reservation when a Vinted payment email arrives (same-day only)
function tryAutoConfirmReservation(pseudo, emailData) {
  if (!pseudo) return false;

  const reservations = loadReservations();
  const pseudoLower = pseudo.toLowerCase().trim();

  const match = reservations.find(r =>
    r.pseudo && r.pseudo.toLowerCase().trim() === pseudoLower &&
    r.status === 'pending'
  );

  if (match) {
    match.status = 'confirmed';
    match.confirmedAt = new Date().toISOString();
    match.confirmedBy = 'email';
    match.emailMatch = emailData;
    saveReservations(reservations);
    console.log(`✅ Réservation #${match.id} auto-confirmée via email Vinted (${pseudo})`);
    return true;
  }

  return false;
}

// Auto-cancel expired reservations (15 min) and restore stock
function expireReservations() {
  const reservations = loadReservations();
  const now = Date.now();
  let changed = false;

  for (const r of reservations) {
    if (r.status === 'pending' && r.expiresAt && new Date(r.expiresAt).getTime() < now) {
      r.status = 'expired';
      const store = loadStore();
      for (const item of r.items) {
        const product = store.products.find(
          p => p.name.toLowerCase() === (item.name || '').toLowerCase()
        );
        if (product) product.stock++;
      }
      saveStore(store);
      changed = true;
      console.log(`⏰ Réservation #${r.id} expirée, stock restauré`);
    }
  }

  if (changed) saveReservations(reservations);
}

// Background checker every 30s
setInterval(expireReservations, 30000);

// ── Patterns Vinted (français) ───────────────────────────────
const VINTED_PATTERNS = {
  achat: [
    /confirmation\s*(?:de\s*)?commande/i,
    /(?:achat|acheté|achetés).*?(?:vinted|confirm)/i,
    /tu\s*as\s*(?:fait\s*une\s*bonne\s*affaire|acheté)/i,
    /nouvelle\s*(?:commande|vente)/i,
  ],
  paiement: [
    /paiement.*?r(?:eçu|eçue)/i,
    /virement.*?reçu/i,
    /tu\s*as\s*reçu\s*un\s*paiement/i,
  ],
  expedition: [
    /(?:étiquette|etiquette).*?(?:livraison|expéd)/i,
    /colis.*?(?:expédié|pris|prêt|envoyé)/i,
    /prépar.*?expédition/i,
  ],
  livraison: [
    /votre.*?colis.*?livr(?:é|ée)/i,
    /commande.*?livr(?:é|ée)/i,
    /objet.*?livr(?:é|ée)/i,
  ],
  remboursement: [
    /rembours(?:é|ement)/i,
    /annulation.*?commande/i,
    /ordre.*?annul/i,
  ]
};

// ── Helpers ───────────────────────────────────────────────────
function extractUsername(text) {
  // Priorité 1: "Acheteur : pseudo"
  const m1 = text.match(/(?:acheteur|vendeur|pseudo|username).*?[:\s]+([a-zA-Z0-9_\-\.]{3,30})/i);
  if (m1) return m1[1].trim().toLowerCase();

  // Priorité 2: patterns Vinted typiques
  const patterns = [
    /(?:de\sla\spart\sde\s)([a-zA-Z0-9_\-\.]{3,30})/i,
    /(?:achat\s+par\s)([a-zA-Z0-9_\-\.]{3,30})/i,
    /([a-zA-Z0-9_\-\.]{3,30})\s*(?:vous|a\s+payé)/i,
  ];

  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      const name = m[1];
      if (name) return name.trim().toLowerCase();
    }
  }
  return null;
}

function extractMontant(text) {
  // € formats: "12,00 €", "12.00 EUR", "Prix : 12€"
  const patterns = [
    /(\d[,\d]*?\d)\s*[€€]/,
    /(\d[,\d]*?\d)\s*EUR/i,
    /(?:prix|montant|total|vendu).*?(\d[.,\d]*?\d)/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return parseFloat(m[1].replace(',', '.'));
  }
  return null;
}

function extractProduitName(text) {
  // "Objet : Nom du produit"
  const m1 = text.match(/(?:objet|article|produit|titre).*?[:\s]+(.+)/i);
  if (m1) return m1[1].trim().replace(/[.,!?\n\r]+$/, '');

  // "Tu vends \"Titre\""
  const m2 = text.match(/(?:[Tt]u\s+vends|vendu)\s*["""]?([A-Za-zÀ-ÿ][^"".!?\n]{5,60})/);
  if (m2) return m2[1].trim();
  return null;
}

function detectStage(text) {
  const lower = text.toLowerCase();
  for (const stage of ['livraison', 'expedition', 'paiement', 'achat', 'remboursement']) {
    if (VINTED_PATTERNS[stage]) {
      for (const p of VINTED_PATTERNS[stage]) {
        if (p.test(text)) return stage;
      }
    }
  }
  return 'unknown';
}

function isVintedEmail(subject, from) {
  const s = ((subject || '') + ' ' + (from || '')).toLowerCase();
  return s.includes('vinted') || s.includes('notifications') || s.includes('@vinted');
}

// ── IMAP : fetch des emails Vinted ─────────────────────────────
function fetchVintedEmails(email, appPassword, daysBack, dateFilter) {
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user: email,
      password: appPassword,
      host: 'imap.mail.yahoo.com',
      port: 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
      connTimeout: 30000,
      authTimeout: 30000,
    });

    const results = [];

    /**
     * Format a Date as "16-May-2026" for IMAP search.
     */
    function imapDateStr(d) {
      return d.toLocaleDateString('en-US', {
        month: 'short', day: '2-digit', year: 'numeric'
      }).replace(',', '');
    }

    imap.once('ready', () => {
      imap.openBox('INBOX', true, (err, box) => {
        if (err) { imap.end(); return reject(err); }

        let searchCriteria;

        if (dateFilter) {
          // dateFilter: Date object → ON (exact date)
          searchCriteria = ['ALL', ['ON', imapDateStr(dateFilter)]];
        } else {
          // daysBack: number → SINCE (past N days, default 7)
          const since = new Date();
          since.setDate(since.getDate() - (daysBack || 7));
          since.setHours(0, 0, 0, 0);
          searchCriteria = ['ALL', ['SINCE', imapDateStr(since)]];
        }

        imap.search(searchCriteria, (err, uids) => {
          if (err || !uids || uids.length === 0) {
            imap.end();
            return resolve([]);
          }

          console.log(`📬 ${uids.length} email(s) trouvé(s)`);

          const fetch = imap.fetch(uids, { bodies: '' });

          fetch.on('message', msg => {
            msg.on('body', stream => {
              simpleParser(stream, (err, parsed) => {
                if (err) return;

                if (!isVintedEmail(parsed.subject || '', parsed.from?.text || '')) return;

                const bodyText = (parsed.text || '') + ' ' + (parsed.html || '');
                const username = extractUsername(bodyText);
                const montant = extractMontant(bodyText);
                const product = extractProduitName(bodyText);
                const stage = detectStage(bodyText);

                if (username || product || stage !== 'unknown') {
                  results.push({
                    id: parsed.messageId || `email_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                    subject: parsed.subject || '',
                    from: parsed.from?.text || '',
                    date: parsed.date || new Date().toISOString(),
                    username,
                    montant,
                    product,
                    stage,
                    preview: (parsed.text || '').slice(0, 300),
                    processed: false,
                    invoiced: false,
                  });
                }
              });
            });
          });

          fetch.once('end', () => imap.end());

          imap.once('end', () => {
            console.log(`📥 ${results.length} email(s) Vinted trouvé(s)`);
            resolve(results);
          });
        });
      });
    });

    imap.once('error', err => {
      console.error('🔴 IMAP error:', err.message);
      imap.end();
      reject(err);
    });

    imap.connect();
  });
}

// ── Core sync ────────────────────────────────────────────────
async function runSync(email, appPassword, daysBack) {
  const store = loadStore();
  const emails = await fetchVintedEmails(email, appPassword, daysBack || 7);

  let newCount = 0;
  for (const email of emails) {
    const exists = store.orders.some(o => o.id === email.id);
    if (!exists) {
      // Tenter de matcher avec un produit connu
      if (email.product && store.products.length > 0) {
        const matchedProduct = store.products.find(p => {
          const bodyLow = (email.product + ' ' + email.subject).toLowerCase();
          return p.name && bodyLow.includes(p.name.toLowerCase());
        });
        if (matchedProduct) {
          email.matchedProduct = matchedProduct.name;
        }
      }
      store.orders.push(email);
      newCount++;

      // Auto-confirm réservation si email de paiement Vinted du jour
      if (email.stage === 'paiement' && email.username) {
        const emailDate = new Date(email.date);
        const today = new Date();
        if (emailDate.toDateString() === today.toDateString()) {
          const confirmed = tryAutoConfirmReservation(email.username, {
            id: email.id,
            date: email.date,
            montant: email.montant,
            subject: email.subject,
          });
          if (confirmed) email.reservationAutoConfirmed = true;
        }
      }
    }
  }

  console.log(`🔄 Sync terminée : ${newCount} nouveau(x) + ${store.orders.length} total`);
  store.meta.lastSync = new Date().toISOString();
  saveStore(store);

  return { new: newCount, total: store.orders.length, emails };
}

// ── Routes ─────────────────────────────────────────────────────

// Status
app.get('/', (req, res) => {
  const store = loadStore();
  res.json({
    status: 'ok',
    message: 'Vinted Automation v2',
    orders: store.orders.length,
    products: store.products.length,
    lastSync: store.meta.lastSync,
  });
});

// Dashboard stats
app.get('/stats', (req, res) => {
  const store = loadStore();
  const orders = store.orders;

  const stats = {
    totalOrders: orders.length,
    ordersByStage: {},
    ordersByMonth: {},
    totalRevenue: 0,
  };

  for (const o of orders) {
    stats.ordersByStage[o.stage] = (stats.ordersByStage[o.stage] || 0) + 1;
    const key = new Date(o.date).toISOString().slice(0, 7);
    stats.ordersByMonth[key] = (stats.ordersByMonth[key] || 0) + 1;
    if (o.montant) stats.totalRevenue += o.montant;
  }

  stats.recent = orders.sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 20);
  stats.products = store.products;

  res.json(stats);
});

// Sync emails (déclenche IMAP)
app.post('/sync', async (req, res) => {
  const { email, appPassword, daysBack } = req.body;

  if (!email || !appPassword) {
    return res.status(400).json({ error: 'email et appPassword requis' });
  }

  try {
    const result = await runSync(email, appPassword, daysBack);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Sync error:', err.message);
    res.status(500).json({ error: 'Erreur IMAP', details: err.message });
  }
});

// Liste des commandes
app.get('/orders', (req, res) => {
  const store = loadStore();
  let orders = [...store.orders];

  if (req.query.stage) {
    orders = orders.filter(o => o.stage === req.query.stage);
  }

  orders.sort((a, b) => new Date(b.date) - new Date(a.date));

  const limit = parseInt(req.query.limit);
  if (limit > 0 && limit < orders.length) {
    orders = orders.slice(0, limit);
  }

  res.json({ total: store.orders.length, filtered: orders.length, orders });
});

// Commandes en attente de facture
app.get('/orders/pending', (req, res) => {
  const store = loadStore();
  const orders = store.orders.filter(o => !o.invoiced && o.stage === 'paiement');
  res.json(orders);
});

// Marquer comme facturé
app.post('/orders/:id/invoice', (req, res) => {
  const store = loadStore();
  const index = store.orders.findIndex(o => o.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Commande introuvable' });

  store.orders[index].invoiced = true;
  store.orders[index].invoicedAt = new Date().toISOString();
  saveStore(store);
  res.json({ success: true, order: store.orders[index] });
});

// Liste des produits
app.get('/products', (req, res) => {
  const store = loadStore();
  let products = store.products;
  // Support ?category=Sticker filtering
  if (req.query.category) {
    const cat = req.query.category.toLowerCase();
    products = products.filter(p => p.category && p.category.toLowerCase() === cat);
  }
  res.json(products);
});

// Ajouter / mettre à jour un produit
app.post('/products', (req, res) => {
  const { name, price, stock, category } = req.body;
  if (!name) return res.status(400).json({ error: 'name requis' });

  const store = loadStore();
  const index = store.products.findIndex(p => p.name.toLowerCase() === name.toLowerCase());

  const product = { name, price: price || 0, stock: stock || 0, category: category || '' };

  if (index >= 0) {
    store.products[index] = { ...store.products[index], ...product };
    console.log(`🔄 Produit mis à jour: ${name}`);
  } else {
    store.products.push(product);
    console.log(`✅ Produit ajouté: ${name}`);
  }

  saveStore(store);
  res.json({ success: true, products: store.products });
});

// Importer produits depuis Produits.md
app.post('/import-products', (req, res) => {
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: 'Markdown requis' });

  const store = loadStore();
  const lines = Array.isArray(content) ? content : [content];
  let parsed = 0;

  for (const raw of lines) {
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('-')) continue;

      // "- Nom du produit | 12€ | 5 en stock"
      const parts = trimmed.replace(/^[-\s*]+/, '').split(/[|:]/);
      if (parts.length >= 2) {
        const product = {
          name: parts[0].trim(),
          price: parseFloat(parts[1].replace(/[€€]/g, '').replace(',', '.')) || 0,
          stock: parseInt(parts[2]) || 0,
          category: (parts[3] || '').trim(),
        };

        const existing = store.products.findIndex(p =>
          p.name.toLowerCase() === product.name.toLowerCase()
        );
        if (existing >= 0) store.products[existing] = product;
        else store.products.push(product);
        parsed++;
      }
    }
  }

  saveStore(store);
  res.json({ success: true, parsed, total: store.products.length });
});

// Nettoyer vieilles commandes
app.delete('/orders/old', (req, res) => {
  const days = parseInt(req.query.days) || 90;
  const cut = new Date();
  cut.setDate(cut.getDate() - days);

  const store = loadStore();
  const before = store.orders.length;
  store.orders = store.orders.filter(o => new Date(o.date) > cut);
  const removed = before - store.orders.length;

  saveStore(store);
  res.json({ success: true, removed, remaining: store.orders.length });
});

// Reset store
app.delete('/store', (req, res) => {
  const { confirm } = req.query;
  if (confirm !== 'yes') return res.status(400).json({ error: 'Ajouter ?confirm=yes' });

  saveStore({ orders: [], products: [], meta: { lastSync: null } });
  res.json({ success: true, message: 'Store réinitialisé' });
});

// Webhook pour le watcher local
app.post('/webhook/order', (req, res) => {
  const { order } = req.body;
  if (!order || !order.id) return res.status(400).json({ error: 'order.id requis' });

  const store = loadStore();
  const exists = store.orders.some(o => o.id === order.id);
  if (exists) return res.json({ success: true, duplicate: true });

  if (order.product && store.products.length) {
    const matched = store.products.find(p =>
      order.product.toLowerCase().includes(p.name.toLowerCase())
    );
    if (matched) order.matchedProduct = matched.name;
  }

  store.orders.push({ ...order, processed: false, invoiced: false });
  saveStore(store);
  console.log(`📦 Commande reçue via webhook: ${order.username || order.id}`);
  res.json({ success: true });
});

// Générer données facture (prête pour Indy)
app.post('/orders/:id/invoice-data', (req, res) => {
  const store = loadStore();
  const order = store.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Commande introuvable' });

  const invoice = {
    invoiceRef: `VINTED-${new Date(order.date).toISOString().slice(0, 10)}-${order.username || 'NA'}`,
    type: 'VENTE',
    buyer: {
      name: order.username || 'Acheteur Vinted',
      email: null,
      vintedUsername: order.username,
    },
    items: [{
      description: order.product || order.matchedProduct || 'Article Vinted',
      quantity: 1,
      unitPrice: order.montant || 0,
      vatRate: 0, // Vinted occasion = pas de TVA
    }],
    totalHT: order.montant || 0,
    totalTTC: order.montant || 0,
    currency: 'EUR',
    paymentStatus: order.stage === 'paiement' ? 'paid' : 'pending',
    source: 'Vinted',
    vintedOrderDate: order.date,
  };

  res.json(invoice);
});

// Export des factures à traiter
app.get('/export/invoices', (req, res) => {
  const store = loadStore();
  const pending = store.orders.filter(o =>
    !o.invoiced && (o.stage === 'paiement' || o.stage === 'livraison')
  );

  const invoices = pending.map(o => ({
    id: o.id,
    username: o.username,
    product: o.product || o.matchedProduct,
    montant: o.montant,
    date: o.date,
  }));

  res.json({ count: invoices.length, invoices });
});

// ── Sticker Shop: Reservation (Vinted Flow) ──────────────────

app.get('/api/stickers', (req, res) => {
  const dir = path.join(__dirname, 'public', 'stickers');
  try {
    const files = fs.readdirSync(dir).filter(f => /\.jpe?g$/i.test(f));
    res.json({ count: files.length, stickers: files.sort() });
  } catch (err) {
    res.status(500).json({ error: 'Erreur lecture dossier stickers' });
  }
});

app.get('/api/bracelets', (req, res) => {
  const dir = path.join(__dirname, 'public', 'bracelets');
  try {
    const files = fs.readdirSync(dir).filter(f => /\.jpe?g$/i.test(f));
    res.json({ count: files.length, bracelets: files.sort() });
  } catch (err) {
    res.status(500).json({ error: 'Erreur lecture dossier bracelets' });
  }
});

app.get('/api/sync', async (req, res) => {
  try {
    const store = await sync();
    res.json({ success: true, products: store.products.length, lastSync: store.meta?.lastSync });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Réserver avec pseudo Vinted → 15 min pour payer
app.post('/api/reserve', (req, res) => {
  const { pseudo, items } = req.body;

  if (!pseudo || !items || items.length === 0) {
    return res.json({ success: false, error: 'pseudo (Vinted) et items requis' });
  }

  // Déduire le stock
  const store = loadStore();
  for (const item of items) {
    const product = store.products.find(
      p => p.name.toLowerCase() === (item.name || '').toLowerCase()
    );
    if (product && product.stock > 0) {
      product.stock--;
    }
  }
  saveStore(store);

  const reservations = loadReservations();
  const reservation = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    pseudo: pseudo.trim().toLowerCase(),
    items,
    status: 'pending',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  };
  reservations.push(reservation);
  saveReservations(reservations);

  console.log(`📩 Réservation #${reservation.id} — ${pseudo} — ${items.length} articles (expire dans 15 min)`);

  res.json({ success: true, id: reservation.id, expiresAt: reservation.expiresAt });
});

// Confirmer manuellement une réservation
app.post('/api/reserve/confirm/:id', (req, res) => {
  const reservations = loadReservations();
  const r = reservations.find(r => r.id === req.params.id && r.status === 'pending');
  if (!r) return res.json({ success: false, error: 'Réservation introuvable ou déjà traitée' });

  r.status = 'confirmed';
  r.confirmedAt = new Date().toISOString();
  r.confirmedBy = 'manual';
  saveReservations(reservations);

  res.json({ success: true, reservation: r });
});

// Annuler une réservation → remet le stock
app.post('/api/reserve/cancel/:id', (req, res) => {
  const reservations = loadReservations();
  const r = reservations.find(r => r.id === req.params.id && r.status === 'pending');
  if (!r) return res.json({ success: false, error: 'Réservation introuvable ou déjà traitée' });

  r.status = 'cancelled';
  r.cancelledAt = new Date().toISOString();

  const store = loadStore();
  for (const item of r.items) {
    const product = store.products.find(
      p => p.name.toLowerCase() === (item.name || '').toLowerCase()
    );
    if (product) product.stock++;
  }
  saveStore(store);
  saveReservations(reservations);

  res.json({ success: true, reservation: r });
});

app.get('/api/reservations', (req, res) => {
  const reservations = loadReservations();
  const pending = reservations.filter(r => r.status === 'pending');
  res.json({
    count: reservations.length,
    pending: pending.length,
    reservations,
  });
});

// ── Start ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

// Sync stock from Google Sheet on startup
sync().then(() => {
  console.log('🔄 Stock sync complete on startup');
}).catch(err => {
  console.error('⚠️ Initial stock sync failed:', err.message);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Vinted Automation Backend v2.0`);
  console.log(`   📡 Port: ${PORT}`);
  console.log(`   💾 Données: ${DATA_FILE}`);
  console.log(`   🌍 Env: ${process.env.NODE_ENV || 'development'}`);
});
