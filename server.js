require('dotenv').config();
const express = require('express');
const axios = require('axios');
const https = require('https');
const cheerio = require('cheerio');
const pdfParse = require('pdf-parse');
const OpenAI = require('openai');
const path = require('path');

const bcuAgent = new https.Agent({ rejectUnauthorized: false });

const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(express.json());
app.use(express.static(path.join(__dirname)));

const HTTP_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'es-UY,es;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
};

// Fuentes estáticas: siempre disponibles como respaldo si la búsqueda no retorna resultados.
// La búsqueda dinámica en bcu.gub.uy/busqueda es el motor principal.
const BCU_SOURCES = [
  {
    name: 'RNRCSF — Recopilación de Normas del Sistema Financiero (PDF oficial)',
    url: 'https://www.bcu.gub.uy/Acerca-de-BCU/Normativa/Documents/Reordenamiento%20de%20la%20Recopilaci%C3%B3n/Sistema%20Financiero/RNRCSF.pdf',
    keywords: ['banco', 'financiero', 'crédito', 'depósito', 'préstamo', 'capital', 'liquidez', 'encaje', 'solvencia', 'patrimonio', 'clasificación', 'provisiones', 'riesgo', 'gobierno corporativo', 'entidad financiera', 'institución financiera', 'cooperativa', 'casa de cambio', 'sociedad', 'sociedades', 'no financiera', 'empresa pública', 'sector público'],
  },
  {
    name: 'RNMV — Recopilación de Normas del Mercado de Valores (PDF oficial)',
    url: 'https://www.bcu.gub.uy/Acerca-de-BCU/Normativa/Documents/Reordenamiento%20de%20la%20Recopilaci%C3%B3n/Mercado%20de%20Valores/RNMV.pdf',
    keywords: ['valores', 'bolsa', 'acciones', 'bonos', 'fideicomiso', 'fondo de inversión', 'mercado de capitales', 'calificadora', 'emisión', 'oferta pública'],
  },
  {
    name: 'RNSR — Recopilación de Normas de Seguros y Reaseguros (PDF oficial)',
    url: 'https://www.bcu.gub.uy/Acerca-de-BCU/Normativa/Documents/Reordenamiento%20de%20la%20Recopilaci%C3%B3n/Seguros/RNSR.pdf',
    keywords: ['seguro', 'reaseguro', 'aseguradora', 'póliza', 'prima', 'siniestro'],
  },
  {
    name: 'RNCFP — Recopilación de Normas de AFAP (PDF oficial)',
    url: 'https://www.bcu.gub.uy/Acerca-de-BCU/Normativa/Documents/Reordenamiento%20de%20la%20Recopilaci%C3%B3n/Afap/RNCFP.pdf',
    keywords: ['afap', 'jubilación', 'pensión', 'ahorro previsional', 'fondo previsional'],
  },
  {
    name: 'Normativa UIAF — Prevención de Lavado de Activos y Financiamiento del Terrorismo',
    url: 'https://www.bcu.gub.uy/Servicios-Financieros-SSF/Paginas/Normativa-UIAF.aspx',
    keywords: ['lavado', 'activos', 'compliance', 'debida diligencia', 'antilavado', 'aml', 'financiamiento terrorismo', 'kyc', 'conozca su cliente', 'pep', 'persona políticamente expuesta', 'plaft', 'uiaf', 'prevención'],
  },
  {
    name: 'Normativa BCU — Página Principal',
    url: 'https://www.bcu.gub.uy/Acerca-de-BCU/Paginas/Normativa.aspx',
    keywords: ['normativa', 'regulación', 'circular', 'resolución', 'decreto', 'ley', 'reglamento'],
  },
  {
    name: 'Leyes — Instituciones Financieras',
    url: 'https://www.bcu.gub.uy/Acerca-de-BCU/Normativa/Paginas/Leyes_Instituciones.aspx',
    keywords: ['ley', 'decreto-ley', 'decreto', 'instituciones', 'legislación'],
  },
  {
    name: 'Política Monetaria y Mercados',
    url: 'https://www.bcu.gub.uy/Politica-Economica-y-Mercados/Paginas/PoliticaMonetaria.aspx',
    keywords: ['monetaria', 'inflación', 'tasa de interés', 'tipo de cambio', 'dólar', 'peso uruguayo', 'copom'],
  },
  {
    name: 'Sistema de Pagos',
    url: 'https://www.bcu.gub.uy/Sistema-de-Pagos/Paginas/default.aspx',
    keywords: ['pago', 'transferencia', 'clearing', 'liquidación', 'cheque', 'dinero electrónico', 'medio de pago'],
  },
];

const docCache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000;

// Genera una query de búsqueda a partir del mensaje del usuario
function buildSearchQuery(message) {
  const stopWords = new Set([
    'que', 'son', 'cual', 'cuales', 'como', 'cuando', 'donde', 'por', 'para',
    'con', 'del', 'los', 'las', 'una', 'unos', 'unas', 'hay', 'sobre', 'segun',
    'este', 'esta', 'estos', 'estas', 'ese', 'esa', 'tiene', 'tienen', 'debo',
    'puedo', 'puede', 'quiero', 'necesito', 'mas', 'pero', 'porque', 'aunque',
    'tambien', 'muy', 'bien', 'mal', 'quien', 'quienes', 'podes', 'decir',
    'dime', 'hablar', 'favor', 'hola', 'gracias', 'normativa', 'norma',
  ]);
  const norm = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const words = norm(message)
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !stopWords.has(w));
  return [...new Set(words)].slice(0, 6).join(' ');
}

// Busca en el buscador oficial del BCU y retorna los documentos encontrados
async function searchBCU(query) {
  if (!query.trim()) return [];
  const searchUrl = `https://www.bcu.gub.uy/busqueda/Paginas/Results.aspx?k=${encodeURIComponent(query)}`;
  try {
    const res = await axios.get(searchUrl, {
      headers: HTTP_HEADERS,
      timeout: 15000,
      maxRedirects: 5,
      httpsAgent: bcuAgent,
    });
    const $ = cheerio.load(res.data);
    const results = [];
    const seen = new Set();
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const text = $(el).text().trim();
      if (!href || text.length < 5) return;
      if (href.includes('busqueda') || href.includes('javascript:') || href.startsWith('#')) return;
      const isBCU = href.includes('bcu.gub.uy') || href.startsWith('/');
      const isPDF = href.toLowerCase().endsWith('.pdf');
      const isPage = href.includes('/Normativa/') || href.includes('/Circulares/') || href.includes('/Paginas/');
      if (isBCU && (isPDF || isPage)) {
        const fullUrl = href.startsWith('http') ? href : `https://www.bcu.gub.uy${href}`;
        if (!seen.has(fullUrl)) {
          seen.add(fullUrl);
          results.push({ name: text.substring(0, 120), url: fullUrl, score: isPDF ? 2 : 1 });
        }
      }
    });
    return results.sort((a, b) => b.score - a.score).slice(0, 6);
  } catch {
    return [];
  }
}

// Selecciona fuentes estáticas relevantes para la query (máx 2 + RNRCSF)
function selectStaticSources(query) {
  const norm = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const q = norm(query);

  const scored = BCU_SOURCES.map(src => ({
    ...src,
    score: src.keywords.reduce((acc, kw) => acc + (q.includes(norm(kw)) ? 1 : 0), 0),
  })).sort((a, b) => b.score - a.score);

  const selected = new Map();

  // RNRCSF siempre incluido — compilación principal
  const rnrcsf = BCU_SOURCES.find(s => s.url.includes('RNRCSF'));
  if (rnrcsf) selected.set(rnrcsf.url, rnrcsf);

  // Hasta 2 fuentes más con mayor puntaje
  for (const src of scored) {
    if (selected.size >= 3) break;
    if (src.score > 0) selected.set(src.url, src);
  }

  return [...selected.values()];
}

async function fetchBCUDoc(source) {
  const cached = docCache.get(source.url);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.data;

  const isPDF = source.url.toLowerCase().includes('.pdf');

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (isPDF) {
        const res = await axios.get(source.url, {
          headers: { ...HTTP_HEADERS, Accept: 'application/pdf,*/*' },
          timeout: 40000,
          maxRedirects: 5,
          httpsAgent: bcuAgent,
          responseType: 'arraybuffer',
        });
        const pdf = await pdfParse(Buffer.from(res.data));
        const content = pdf.text.replace(/\s+/g, ' ').trim();
        const data = { name: source.name, url: source.url, content, isPDF: true, links: [], fetchedAt: new Date().toISOString() };
        docCache.set(source.url, { data, ts: Date.now() });
        return data;
      }

      const res = await axios.get(source.url, {
        headers: HTTP_HEADERS,
        timeout: 20000,
        maxRedirects: 5,
        httpsAgent: bcuAgent,
      });
      const $ = cheerio.load(res.data);
      $('script, style, nav, header, footer, #s4-ribbonrow, .ms-nav, .ms-siteactionsmenu, #DeltaSiteLogo').remove();

      const pdfLinks = [];
      $('a[href]').each((_, el) => {
        const href = $(el).attr('href') || '';
        const text = $(el).text().trim();
        if (href && (href.toLowerCase().includes('.pdf') || href.includes('/Circulares/') || href.includes('/Normativa/'))) {
          const fullUrl = href.startsWith('http') ? href : `https://www.bcu.gub.uy${href}`;
          if (text && !pdfLinks.find(l => l.url === fullUrl)) {
            pdfLinks.push({ text: text.substring(0, 120), url: fullUrl });
          }
        }
      });

      const content = $('body').text().replace(/\s+/g, ' ').trim().substring(0, 12000);
      const data = { name: source.name, url: source.url, content, links: pdfLinks.slice(0, 30), fetchedAt: new Date().toISOString() };
      docCache.set(source.url, { data, ts: Date.now() });
      return data;
    } catch {
      if (attempt === 0) await new Promise(r => setTimeout(r, 1500));
    }
  }

  if (cached) return cached.data;
  return null;
}

function extractRelevantSections(text, query, maxLength = 20000) {
  const norm = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const textNorm = norm(text);
  const terms = [];

  const nums = query.match(/\b\d{1,4}\b/g);
  if (nums) {
    nums.forEach(n => {
      terms.push(`articulo ${n} `);
      terms.push(`articulo ${n}.`);
      terms.push(`articulo ${n}-`);
      terms.push(`art. ${n} `);
      terms.push(`art ${n} `);
    });
  }

  const stopWords = new Set(['hola', 'que', 'del', 'los', 'las', 'una', 'por', 'con', 'para', 'como', 'cual', 'este', 'esta', 'sobre', 'podes', 'dime', 'cuales', 'segun', 'favor']);
  query.split(/\s+/).forEach(w => {
    const wn = norm(w.replace(/[^a-z0-9]/gi, ''));
    if (wn.length > 4 && !stopWords.has(wn) && !terms.includes(wn)) terms.push(wn);
  });

  if (nums) nums.forEach(n => { if (!terms.includes(n)) terms.push(n); });

  const windowSize = 5000;
  const sections = [];
  const used = [];

  for (const term of terms) {
    const t = norm(term);
    let pos = 0;
    while (pos < textNorm.length) {
      const idx = textNorm.indexOf(t, pos);
      if (idx === -1) break;
      const start = Math.max(0, idx - 200);
      const end = Math.min(text.length, idx + windowSize);
      const overlaps = used.some(([s, e]) => !(end <= s || start >= e));
      if (!overlaps) {
        used.push([start, end]);
        sections.push(text.substring(start, end));
        if (sections.join('').length >= maxLength) break;
      }
      pos = idx + t.length + 200;
    }
    if (sections.length > 0 && term.includes(' ')) break;
    if (sections.join('').length >= maxLength) break;
  }

  if (sections.length === 0) return text.substring(0, maxLength);
  return sections.join('\n\n[...]\n\n').substring(0, maxLength);
}

const SYSTEM_PROMPT = `Eres un asistente especializado en la normativa del Banco Central del Uruguay (BCU).

REGLA ABSOLUTA: Respondé ÚNICAMENTE con información que esté presente en los documentos oficiales del BCU que se te proporcionan. No uses conocimiento propio ni ninguna fuente externa.

PROCESO:
1. Leé todos los documentos proporcionados.
2. Buscá exhaustivamente el tema consultado en esos documentos.
3. Si encontrás información relevante: citala o parafraseala indicando la fuente y su URL.
4. Si la información no está en los documentos provistos: respondé exactamente esto: "No encontré información sobre ese tema en los documentos del BCU que pude consultar. Te recomiendo buscar directamente en [bcu.gub.uy](https://www.bcu.gub.uy) o reformular la pregunta para que pueda buscar con otros términos."

INSTRUCCIONES:
- Respondé siempre en español, de forma clara, precisa y profesional.
- Citá artículos, circulares o resoluciones exactamente como aparecen en los documentos.
- No extrapoles ni inferás más allá del texto de los documentos.

FORMATO:
- Usá listas cuando corresponda.
- Referencias normativas: **[Tipo] Nº [número] — [descripción]**
- Al final de cada respuesta listá las fuentes consultadas con su URL.`;

app.post('/api/chat', async (req, res) => {
  const { message, history = [] } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'Mensaje requerido' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  try {
    const searchQuery = buildSearchQuery(message);
    const staticSources = selectStaticSources(message);

    // 1. Búsqueda en BCU + fetch de fuentes estáticas en paralelo
    const [searchResults, staticDocs] = await Promise.all([
      searchBCU(searchQuery),
      Promise.all(staticSources.map(fetchBCUDoc)),
    ]);

    // 2. Los resultados de búsqueda van primero (más relevantes); luego fuentes estáticas sin repetir
    const seenUrls = new Set(searchResults.map(r => r.url));
    const extraStatic = staticSources.filter(s => !seenUrls.has(s.url));
    const allSources = [...searchResults, ...extraStatic];

    // 3. Fetchear resultados de búsqueda (limitado a los 4 más relevantes para no saturar)
    const searchDocs = await Promise.all(
      searchResults.slice(0, 4).map(fetchBCUDoc)
    );

    // 4. Combinar todos los documentos obtenidos, sin duplicados
    const validDocs = [];
    const addedUrls = new Set();
    for (const doc of [...searchDocs, ...staticDocs]) {
      if (doc && !addedUrls.has(doc.url)) {
        addedUrls.add(doc.url);
        validDocs.push(doc);
      }
    }

    // 5. Si no se pudo acceder a ningún documento, responder honestamente
    if (validDocs.length === 0) {
      res.write(`data: ${JSON.stringify({ type: 'text', content: 'No pude acceder al sitio oficial del BCU en este momento. Por favor intentá de nuevo en unos instantes o consultá directamente en [bcu.gub.uy](https://www.bcu.gub.uy).' })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'sources', sources: [] })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      return;
    }

    // 6. Buscar PDFs adicionales en los links de páginas HTML ya fetcheadas
    const norm = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const queryNorm = norm(message);
    const pdfCandidates = [];

    for (const doc of validDocs) {
      if (!doc.links) continue;
      for (const link of doc.links) {
        if (!link.url.toLowerCase().includes('.pdf') || addedUrls.has(link.url)) continue;
        const linkNorm = norm(link.text);
        let score = 0;
        const nums = message.match(/\b\d{1,4}\b/g);
        if (nums) nums.forEach(n => { if (linkNorm.includes(n)) score += 3; });
        queryNorm.split(/\s+/).forEach(w => { if (w.length > 3 && linkNorm.includes(w)) score += 1; });
        if (score > 0) {
          pdfCandidates.push({ name: link.text, url: link.url, score });
          addedUrls.add(link.url);
        }
      }
    }

    if (pdfCandidates.length > 0) {
      pdfCandidates.sort((a, b) => b.score - a.score);
      const extraPDFs = await Promise.all(pdfCandidates.slice(0, 2).map(fetchBCUDoc));
      extraPDFs.filter(Boolean).forEach(d => validDocs.push(d));
    }

    // 7. Construir contexto para el modelo
    const docsContext = validDocs.map(doc => {
      const content = doc.isPDF
        ? extractRelevantSections(doc.content, message)
        : doc.content;
      let section = `### ${doc.name}\n**URL:** ${doc.url}\n\n${content}`;
      if (doc.links && doc.links.length > 0) {
        section += `\n\n**Enlaces encontrados en este documento:**\n${doc.links.map(l => `- ${l.text}: ${l.url}`).join('\n')}`;
      }
      return section;
    }).join('\n\n---\n\n');

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history.filter(m => m.role && m.content).map(m => ({ role: m.role, content: m.content })),
      {
        role: 'user',
        content: `A continuación están los documentos oficiales obtenidos de bcu.gub.uy. Respondé la consulta basándote EXCLUSIVAMENTE en esta información:\n\n${docsContext}\n\nConsulta: ${message}`,
      },
    ];

    const stream = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      stream: true,
    });

    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content || '';
      if (text) res.write(`data: ${JSON.stringify({ type: 'text', content: text })}\n\n`);
    }

    res.write(`data: ${JSON.stringify({ type: 'sources', sources: validDocs.map(d => ({ name: d.name, url: d.url })) })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
  } catch (err) {
    console.error('[Chat error]', err.message);
    res.write(`data: ${JSON.stringify({ type: 'error', message: 'Error al procesar la consulta. Verificá tu API key o intentá de nuevo.' })}\n\n`);
  } finally {
    res.end();
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🏦  BCU Normativa Assistant → http://localhost:${PORT}\n`);

  // Pre-calentar los PDFs principales en background
  const toPrewarm = BCU_SOURCES.filter(s => s.url.includes('.pdf'));
  console.log(`[Cache] Pre-cargando ${toPrewarm.length} PDFs en background...`);
  toPrewarm.forEach(s => fetchBCUDoc(s).catch(() => {}));
});
