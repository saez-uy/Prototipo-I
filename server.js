require('dotenv').config();
const express = require('express');
const axios = require('axios');
const https = require('https');
const cheerio = require('cheerio');
const pdfParse = require('pdf-parse');
const OpenAI = require('openai');
const path = require('path');

const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(express.json());
app.use(express.static(path.join(__dirname)));

const bcuAgent = new https.Agent({ rejectUnauthorized: false });

const HTTP_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'es-UY,es;q=0.9',
  'Connection': 'keep-alive',
};

// ─── Caché ────────────────────────────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 min para normativa
const CACHE_TTL_COTIZ = 60 * 1000; // 1 min para cotizaciones (dato en tiempo real)

function getCache(url, ttl = CACHE_TTL) {
  const entry = cache.get(url);
  if (entry && Date.now() - entry.ts < ttl) return entry.data;
  return null;
}

// ─── Cotizaciones: servicio SOAP oficial del BCU ───────────────────────────────
async function fetchCotizaciones() {
  const cached = getCache('__cotizaciones__', CACHE_TTL_COTIZ);
  if (cached) return cached;

  const hoy = new Date();
  const fmt = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
  const ayer = new Date(hoy); ayer.setDate(hoy.getDate() - 3); // margen para fines de semana

  const soap = `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:awl="http://awsbcucotiz.bcu.gub.uy">
  <soapenv:Header/>
  <soapenv:Body>
    <awl:awsbcucotizRequest>
      <Moneda>2222</Moneda>
      <FechaDesde>${fmt(ayer)}</FechaDesde>
      <FechaHasta>${fmt(hoy)}</FechaHasta>
      <Grupo>0</Grupo>
    </awl:awsbcucotizRequest>
  </soapenv:Body>
</soapenv:Envelope>`;

  try {
    const res = await axios.post(
      'https://cotizaciones.bcu.gub.uy/wscotizaciones/servlet/awsbcucotiz',
      soap,
      { headers: { 'Content-Type': 'text/xml; charset=utf-8' }, timeout: 8000, httpsAgent: bcuAgent }
    );

    const xml = res.data;
    const get = (tag) => { const m = xml.match(new RegExp(`<[^:]*:?${tag}[^>]*>([^<]+)<`)); return m ? m[1].trim() : null; };

    const rows = [...xml.matchAll(/<Datoscotizaciones>([\s\S]*?)<\/Datoscotizaciones>/gi)];
    const lines = rows.map(r => {
      const block = r[1];
      const g = (t) => { const m = block.match(new RegExp(`<[^:]*:?${t}[^>]*>([^<]+)<`)); return m ? m[1].trim() : '?'; };
      return `  Fecha: ${g('Fecha')} | Compra: ${g('Compra')} | Venta: ${g('Venta')}`;
    });

    if (lines.length === 0) return null;

    const content = `Cotizaciones del dólar estadounidense (USD) — Fuente: Banco Central del Uruguay\n\n${lines.join('\n')}\n\nFuente oficial: https://www.bcu.gub.uy/Estadisticas-e-Indicadores/Paginas/Cotizaciones.aspx`;
    const data = { name: 'Cotizaciones BCU — Dólar (USD)', url: 'https://www.bcu.gub.uy/Estadisticas-e-Indicadores/Paginas/Cotizaciones.aspx', content, isPDF: false, links: [] };
    cache.set('__cotizaciones__', { data, ts: Date.now() });
    return data;
  } catch {
    return null;
  }
}

// ─── Fetch de página HTML del BCU ─────────────────────────────────────────────
async function fetchHTML(source) {
  const cached = getCache(source.url);
  if (cached) return cached;

  try {
    const res = await axios.get(source.url, { headers: HTTP_HEADERS, timeout: 8000, maxRedirects: 5, httpsAgent: bcuAgent });
    const $ = cheerio.load(res.data);
    $('script, style, nav, header, footer, #s4-ribbonrow, .ms-nav, .ms-siteactionsmenu').remove();

    const links = [];
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const text = $(el).text().trim();
      if (!href || !text || href.startsWith('#') || href.includes('javascript:')) return;
      const isPDF = href.toLowerCase().endsWith('.pdf');
      const isPage = href.includes('bcu.gub.uy') || href.startsWith('/');
      if (isPDF || (isPage && href.includes('/Normativa/'))) {
        const url = href.startsWith('http') ? href : `https://www.bcu.gub.uy${href}`;
        if (!links.find(l => l.url === url)) links.push({ text: text.slice(0, 100), url });
      }
    });

    const content = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 15000);
    const data = { name: source.name, url: source.url, content, isPDF: false, links: links.slice(0, 40) };
    cache.set(source.url, { data, ts: Date.now() });
    return data;
  } catch {
    return null;
  }
}

// ─── Fetch de PDF del BCU ──────────────────────────────────────────────────────
async function fetchPDF(source) {
  const cached = getCache(source.url);
  if (cached) return cached;

  try {
    const res = await axios.get(source.url, {
      headers: { ...HTTP_HEADERS, Accept: 'application/pdf,*/*' },
      timeout: 20000, maxRedirects: 5, httpsAgent: bcuAgent, responseType: 'arraybuffer',
    });
    const pdf = await pdfParse(Buffer.from(res.data));
    const content = pdf.text.replace(/\s+/g, ' ').trim();
    const data = { name: source.name, url: source.url, content, isPDF: true, links: [] };
    cache.set(source.url, { data, ts: Date.now() });
    return data;
  } catch {
    return null;
  }
}

function fetchDoc(source) {
  return source.url.toLowerCase().endsWith('.pdf') ? fetchPDF(source) : fetchHTML(source);
}

// ─── Búsqueda en el buscador oficial del BCU ──────────────────────────────────
async function searchBCU(query) {
  const url = `https://www.bcu.gub.uy/busqueda/Paginas/Results.aspx?k=${encodeURIComponent(query)}`;
  try {
    const res = await axios.get(url, { headers: HTTP_HEADERS, timeout: 8000, maxRedirects: 5, httpsAgent: bcuAgent });
    const $ = cheerio.load(res.data);
    const results = [];
    const seen = new Set();

    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const text = $(el).text().trim();
      if (!href || text.length < 5 || href.includes('busqueda') || href.includes('javascript:') || href.startsWith('#')) return;
      const isBCU = href.includes('bcu.gub.uy') || href.startsWith('/');
      const isPDF = href.toLowerCase().endsWith('.pdf');
      const isPage = href.includes('/Normativa/') || href.includes('/Circulares/') || href.includes('/Paginas/') || href.includes('/Estadisticas/');
      if (isBCU && (isPDF || isPage)) {
        const fullUrl = href.startsWith('http') ? href : `https://www.bcu.gub.uy${href}`;
        if (!seen.has(fullUrl)) {
          seen.add(fullUrl);
          results.push({ name: text.slice(0, 120), url: fullUrl, score: isPDF ? 2 : 1 });
        }
      }
    });

    return results.sort((a, b) => b.score - a.score).slice(0, 5);
  } catch {
    return [];
  }
}

// ─── Páginas estáticas de respaldo (cuando la búsqueda no retorna nada) ────────
const FALLBACK_PAGES = [
  { name: 'Cotizaciones — BCU', url: 'https://www.bcu.gub.uy/Estadisticas-e-Indicadores/Paginas/Cotizaciones.aspx', keywords: ['cotizacion', 'dolar', 'euro', 'tipo de cambio', 'divisa', 'moneda'] },
  { name: 'Tasas de Interés Medias — BCU', url: 'https://www.bcu.gub.uy/Servicios-Financieros-SSF/Paginas/Tasas-Medias.aspx', keywords: ['tasa', 'interes', 'prestamo', 'deposito'] },
  { name: 'Inflación — BCU', url: 'https://www.bcu.gub.uy/Estadisticas-e-Indicadores/Paginas/Encuesta-Inflacion.aspx', keywords: ['inflacion', 'ipc', 'precios', 'expectativas'] },
  { name: 'Estadísticas e Indicadores — BCU', url: 'https://www.bcu.gub.uy/Estadisticas-e-Indicadores/Paginas/Estadisticas-y-Estudios.aspx', keywords: ['estadistica', 'indicador', 'dato', 'informe'] },
  { name: 'Normativa BCU', url: 'https://www.bcu.gub.uy/Acerca-de-BCU/Paginas/Normativa.aspx', keywords: ['normativa', 'circular', 'resolucion', 'decreto', 'ley', 'reglamento'] },
  { name: 'Recopilación Normas — Sistema Financiero', url: 'https://www.bcu.gub.uy/Acerca-de-BCU/Normativa/Paginas/Recopilacion-de-Normas-Instituciones.aspx', keywords: ['banco', 'financiero', 'entidad', 'cooperativa', 'casa de cambio'] },
  { name: 'Normativa UIAF — Lavado de Activos', url: 'https://www.bcu.gub.uy/Servicios-Financieros-SSF/Paginas/Normativa-UIAF.aspx', keywords: ['lavado', 'activos', 'kyc', 'debida diligencia', 'aml', 'plaft', 'uiaf'] },
  { name: 'Política Monetaria — BCU', url: 'https://www.bcu.gub.uy/Politica-Economica-y-Mercados/Paginas/PoliticaMonetaria.aspx', keywords: ['monetaria', 'inflacion', 'copom', 'politica'] },
  { name: 'Mercado de Valores — BCU', url: 'https://www.bcu.gub.uy/Servicios-Financieros-SSF/Paginas/MercadoDeValores.aspx', keywords: ['valores', 'bolsa', 'acciones', 'bonos', 'fideicomiso'] },
  { name: 'Seguros y Reaseguros — BCU', url: 'https://www.bcu.gub.uy/Servicios-Financieros-SSF/Paginas/Seguros.aspx', keywords: ['seguro', 'reaseguro', 'poliza', 'prima', 'siniestro'] },
  { name: 'Sistema de Pagos — BCU', url: 'https://www.bcu.gub.uy/Sistema-de-Pagos/Paginas/default.aspx', keywords: ['pago', 'transferencia', 'cheque', 'clearing'] },
];

function selectFallbackPages(query) {
  const norm = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const q = norm(query);
  return FALLBACK_PAGES
    .map(p => ({ ...p, score: p.keywords.reduce((n, kw) => n + (q.includes(norm(kw)) ? 1 : 0), 0) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

// ─── Extracción de secciones relevantes de PDFs ────────────────────────────────
function extractSections(text, query, maxLen = 20000) {
  const norm = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const textNorm = norm(text);
  const stop = new Set(['que', 'del', 'los', 'las', 'una', 'por', 'con', 'para', 'como', 'cual', 'este', 'esta', 'sobre']);
  const terms = [];

  const nums = query.match(/\b\d{1,4}\b/g) || [];
  nums.forEach(n => { terms.push(`articulo ${n} `, `art. ${n} `, `art ${n} `); });

  query.split(/\s+/).forEach(w => {
    const wn = norm(w.replace(/[^a-z0-9]/gi, ''));
    if (wn.length > 4 && !stop.has(wn) && !terms.includes(wn)) terms.push(wn);
  });

  nums.forEach(n => { if (!terms.includes(n)) terms.push(n); });

  const sections = [];
  const used = [];

  for (const term of terms) {
    const t = norm(term);
    let pos = 0;
    while (pos < textNorm.length) {
      const idx = textNorm.indexOf(t, pos);
      if (idx === -1) break;
      const start = Math.max(0, idx - 200);
      const end = Math.min(text.length, idx + 5000);
      if (!used.some(([s, e]) => !(end <= s || start >= e))) {
        used.push([start, end]);
        sections.push(text.slice(start, end));
        if (sections.join('').length >= maxLen) break;
      }
      pos = idx + t.length + 200;
    }
    if (sections.length > 0 && term.includes(' ')) break;
    if (sections.join('').length >= maxLen) break;
  }

  return sections.length > 0
    ? sections.join('\n\n[...]\n\n').slice(0, maxLen)
    : text.slice(0, maxLen);
}

// ─── Detección de consulta sobre cotizaciones ──────────────────────────────────
function isCotizQuery(msg) {
  const norm = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const q = norm(msg);
  return ['cotizacion', 'dolar', 'euro', 'tipo de cambio', 'divisa', 'cambio moneda'].some(kw => q.includes(kw));
}

// ─── System prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Eres un asistente del Banco Central del Uruguay (BCU).

REGLA ABSOLUTA: Respondé ÚNICAMENTE con información que esté en los documentos oficiales del BCU que se te proporcionan. Sin excepciones.

INSTRUCCIONES:
- Si encontrás la información en los documentos: respondé citando la fuente y su URL.
- Si la información no está en los documentos proporcionados: respondé exactamente "No encontré información sobre ese tema en los documentos del BCU disponibles. Podés buscar directamente en [bcu.gub.uy](https://www.bcu.gub.uy)."
- No uses conocimiento propio ni fuentes externas.
- Respondé siempre en español, claro y profesional.

FORMATO:
- Usá listas cuando corresponda.
- Referencias: **[Tipo] Nº [número] — [descripción]**
- Listá las fuentes consultadas con su URL al final.`;

// ─── Endpoint principal ────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { message, history = [] } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'Mensaje requerido' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  try {
    const docs = [];
    const seen = new Set();

    const addDoc = (d) => { if (d && !seen.has(d.url)) { seen.add(d.url); docs.push(d); } };

    // 1. Para consultas de cotizaciones, usar el servicio SOAP del BCU directamente
    if (isCotizQuery(message)) {
      const cotiz = await fetchCotizaciones();
      if (cotiz) addDoc(cotiz);
    }

    // 2. Buscar en el buscador oficial del BCU con el mensaje del usuario
    const searchResults = await searchBCU(message);

    // 3. Fetchear los resultados de búsqueda en paralelo
    const searchDocs = await Promise.all(searchResults.map(fetchDoc));
    searchDocs.forEach(addDoc);

    // 4. Si la búsqueda no dio resultados, usar páginas de respaldo
    if (searchResults.length === 0) {
      const fallback = selectFallbackPages(message);
      const fallbackDocs = await Promise.all(fallback.map(fetchHTML));
      fallbackDocs.forEach(addDoc);
    }

    // 5. Desde las páginas HTML obtenidas, buscar y descargar PDFs relevantes
    const norm = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const qNorm = norm(message);
    const pdfCandidates = [];

    for (const doc of docs) {
      if (!doc.links) continue;
      for (const link of doc.links) {
        if (!link.url.toLowerCase().endsWith('.pdf') || seen.has(link.url)) continue;
        const score = norm(link.text).split(/\s+/).filter(w => w.length > 3 && qNorm.includes(w)).length;
        if (score > 0) pdfCandidates.push({ name: link.text, url: link.url, score });
      }
    }

    if (pdfCandidates.length > 0) {
      pdfCandidates.sort((a, b) => b.score - a.score);
      const pdfDocs = await Promise.all(pdfCandidates.slice(0, 2).map(fetchPDF));
      pdfDocs.forEach(addDoc);
    }

    // 6. Sin ningún documento: BCU inaccesible
    if (docs.length === 0) {
      res.write(`data: ${JSON.stringify({ type: 'text', content: 'No pude acceder al sitio oficial del BCU en este momento. Por favor intentá de nuevo o consultá directamente en [bcu.gub.uy](https://www.bcu.gub.uy).' })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'sources', sources: [] })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      return;
    }

    // 7. Construir contexto y llamar al modelo
    const context = docs.map(doc => {
      const content = doc.isPDF ? extractSections(doc.content, message) : doc.content;
      let section = `### ${doc.name}\nURL: ${doc.url}\n\n${content}`;
      if (doc.links?.length > 0) section += `\n\nEnlaces encontrados:\n${doc.links.map(l => `- ${l.text}: ${l.url}`).join('\n')}`;
      return section;
    }).join('\n\n---\n\n');

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history.filter(m => m.role && m.content),
      { role: 'user', content: `Documentos obtenidos de bcu.gub.uy:\n\n${context}\n\nPregunta: ${message}` },
    ];

    const stream = await openai.chat.completions.create({ model: 'gpt-4o-mini', messages, stream: true });

    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content || '';
      if (text) res.write(`data: ${JSON.stringify({ type: 'text', content: text })}\n\n`);
    }

    res.write(`data: ${JSON.stringify({ type: 'sources', sources: docs.map(d => ({ name: d.name, url: d.url })) })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);

  } catch (err) {
    console.error('[Chat error]', err.message);
    res.write(`data: ${JSON.stringify({ type: 'error', message: 'Error al procesar la consulta.' })}\n\n`);
  } finally {
    res.end();
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n BCU Assistant → http://localhost:${PORT}\n`);
  // Pre-calentar páginas de respaldo en background
  FALLBACK_PAGES.forEach(p => fetchHTML(p).catch(() => {}));
});
