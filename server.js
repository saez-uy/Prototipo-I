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

const BCU_SOURCES = [
  {
    name: 'RNRCSF — Recopilación de Normas del Sistema Financiero (PDF oficial)',
    url: 'https://www.bcu.gub.uy/Acerca-de-BCU/Normativa/Documents/Reordenamiento%20de%20la%20Recopilaci%C3%B3n/Sistema%20Financiero/RNRCSF.pdf',
    keywords: ['rnrcsf', 'recopilación', 'banco', 'financiero', 'crédito', 'depósito', 'préstamo', 'capital', 'liquidez', 'encaje', 'solvencia', 'patrimonio', 'clasificación', 'provisiones', 'riesgo', 'gobierno corporativo', 'entidad financiera', 'institución financiera', 'cooperativa', 'casa de cambio', 'norma', 'reglamento'],
  },
  {
    name: 'Normativa BCU — Página Principal',
    url: 'https://www.bcu.gub.uy/Acerca-de-BCU/Paginas/Normativa.aspx',
    keywords: ['normativa', 'regulación', 'circular', 'resolución', 'decreto', 'ley', 'reglamento'],
  },
  {
    name: 'Recopilación de Normas — Sistema Financiero (índice)',
    url: 'https://www.bcu.gub.uy/Acerca-de-BCU/Normativa/Paginas/Recopilacion-de-Normas-Instituciones.aspx',
    keywords: ['banco', 'financiero', 'entidad financiera', 'institución financiera', 'cooperativa', 'casa de cambio', 'índice'],
  },
  {
    name: 'Leyes — Instituciones Financieras',
    url: 'https://www.bcu.gub.uy/Acerca-de-BCU/Normativa/Paginas/Leyes_Instituciones.aspx',
    keywords: ['ley', 'decreto-ley', 'decreto', 'instituciones', 'bancos', 'legislación'],
  },
  {
    name: 'Prevención de Lavado de Activos y Financiamiento del Terrorismo',
    url: 'https://www.bcu.gub.uy/Servicios-Financieros-SSF/Paginas/PrevLavado.aspx',
    keywords: ['lavado', 'activos', 'compliance', 'debida diligencia', 'antilavado', 'aml', 'ftf', 'financiamiento terrorismo', 'kyc', 'conozca su cliente', 'pep', 'persona políticamente expuesta', 'sarlaft'],
  },
  {
    name: 'Política Monetaria y Mercados',
    url: 'https://www.bcu.gub.uy/Politica-Economica-y-Mercados/Paginas/PoliticaMonetaria.aspx',
    keywords: ['monetaria', 'inflación', 'tasa de interés', 'tipo de cambio', 'dólar', 'peso uruguayo', 'comité de política monetaria', 'copom'],
  },
  {
    name: 'Mercado de Valores',
    url: 'https://www.bcu.gub.uy/Servicios-Financieros-SSF/Paginas/MercadoDeValores.aspx',
    keywords: ['valores', 'bolsa', 'acciones', 'bonos', 'fideicomiso', 'fondo de inversión', 'mercado de capitales', 'calificadora', 'emisión', 'oferta pública'],
  },
  {
    name: 'Seguros y Reaseguros',
    url: 'https://www.bcu.gub.uy/Servicios-Financieros-SSF/Paginas/Seguros.aspx',
    keywords: ['seguro', 'reaseguro', 'aseguradora', 'póliza', 'prima', 'siniestro', 'superintendencia seguros'],
  },
  {
    name: 'Consultas Normativas — SSF',
    url: 'https://www.bcu.gub.uy/Servicios-Financieros-SSF/Paginas/Consultas-Normativas.aspx',
    keywords: ['consulta', 'interpretación', 'servicios financieros', 'superintendencia'],
  },
  {
    name: 'Sistema de Pagos',
    url: 'https://www.bcu.gub.uy/Sistema-de-Pagos/Paginas/default.aspx',
    keywords: ['pago', 'transferencia', 'clearing', 'liquidación', 'cheque', 'dinero electrónico', 'medio de pago', 'sistema de pagos'],
  },
];

const docCache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000;

async function fetchBCUPage(source) {
  const cached = docCache.get(source.url);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.data;

  const isPDF = source.url.toLowerCase().includes('.pdf');

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
      const content = pdf.text.replace(/\s+/g, ' ').trim(); // texto completo, sin límite

      const data = { name: source.name, url: source.url, content, isPDF: true, links: [], fetchedAt: new Date().toISOString() };
      docCache.set(source.url, { data, ts: Date.now() });
      return data;
    }

    const res = await axios.get(source.url, {
      headers: HTTP_HEADERS,
      timeout: 12000,
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

    const rawText = $('body').text().replace(/\s+/g, ' ').trim();
    const content = rawText.substring(0, 7000);

    const data = {
      name: source.name,
      url: source.url,
      content,
      links: pdfLinks.slice(0, 25),
      fetchedAt: new Date().toISOString(),
    };
    docCache.set(source.url, { data, ts: Date.now() });
    return data;
  } catch (err) {
    console.error(`[BCU fetch error] ${source.url}: ${err.message}`);
    return null;
  }
}

function extractRelevantSections(text, query, maxLength = 20000) {
  const norm = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const textNorm = norm(text);
  const queryNorm = norm(query);

  const terms = new Set();

  // Números de artículo mencionados en la consulta
  const nums = query.match(/\b\d{1,4}\b/g);
  if (nums) nums.forEach(n => {
    terms.add(n);
    terms.add(`articulo ${n}`);
    terms.add(`art. ${n}`);
    terms.add(`art ${n}`);
  });

  // Palabras clave significativas de la consulta
  const stopWords = new Set(['que', 'del', 'los', 'las', 'una', 'unos', 'unas', 'por', 'con', 'para', 'como', 'dice', 'cual', 'este', 'esta', 'hace', 'sobre']);
  query.split(/\s+/).forEach(w => {
    const wn = norm(w.replace(/[^a-z0-9áéíóúüñ]/gi, ''));
    if (wn.length > 3 && !stopWords.has(wn)) terms.add(wn);
  });

  const windowSize = 4000;
  const sections = [];
  const used = [];

  for (const term of terms) {
    const t = norm(term);
    let pos = 0;
    while (pos < textNorm.length) {
      const idx = textNorm.indexOf(t, pos);
      if (idx === -1) break;
      const start = Math.max(0, idx - 300);
      const end = Math.min(text.length, idx + windowSize);
      const overlaps = used.some(([s, e]) => !(end <= s || start >= e));
      if (!overlaps) {
        used.push([start, end]);
        sections.push(text.substring(start, end));
        if (sections.join('').length >= maxLength) break;
      }
      pos = idx + t.length + 500;
    }
    if (sections.join('').length >= maxLength) break;
  }

  if (sections.length === 0) return text.substring(0, maxLength);
  return sections.join('\n\n[...]\n\n').substring(0, maxLength);
}

function selectSources(query) {
  const q = query.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const scored = BCU_SOURCES.map(src => {
    const kwScore = src.keywords.reduce((acc, kw) => {
      const kwNorm = kw.normalize('NFD').replace(/[̀-ͯ]/g, '');
      return acc + (q.includes(kwNorm) ? 1 : 0);
    }, 0);
    return { ...src, score: kwScore };
  }).sort((a, b) => b.score - a.score);

  const selected = scored.slice(0, 2);
  scored.slice(2).forEach(s => { if (s.score > 0) selected.push(s); });
  return selected.slice(0, 4);
}

const SYSTEM_PROMPT = `Eres un asistente especializado en la normativa del Banco Central del Uruguay (BCU).

REGLA FUNDAMENTAL: Solo podés responder basándote EXCLUSIVAMENTE en los documentos oficiales del BCU que se te proporcionan en cada consulta. Está terminantemente prohibido usar conocimiento propio, entrenamiento previo o cualquier fuente que no sea los documentos adjuntos.

INSTRUCCIONES:
- Responde siempre en español, de forma clara, precisa y profesional.
- Si la información solicitada está en los documentos proporcionados, respondé citando el documento y la URL.
- Si mencionás una circular o resolución, incluí su número exacto tal como aparece en los documentos.
- Si la información solicitada NO está en los documentos proporcionados, respondé exactamente: "No encontré información sobre ese tema en los documentos oficiales del BCU disponibles. Te recomiendo consultar directamente en bcu.gub.uy."
- Nunca inferás, extrapoles ni complementes con conocimiento externo a los documentos.
- Si el usuario pregunta algo fuera del ámbito del BCU, indicá que solo podés responder sobre normativa del BCU.

FORMATO:
- Usá listas cuando sea apropiado para facilitar la lectura.
- Para referencias normativas usá: **[Tipo] Nº [número] — [Descripción breve]**
- Incluí al final las fuentes consultadas con su URL.`;

app.post('/api/chat', async (req, res) => {
  const { message, history = [] } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'Mensaje requerido' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  try {
    const sources = selectSources(message);
    const fetchedDocs = await Promise.all(sources.map(fetchBCUPage));
    const validDocs = fetchedDocs.filter(Boolean);

    if (validDocs.length === 0) {
      res.write(`data: ${JSON.stringify({ type: 'text', content: 'No pude acceder a los documentos oficiales del BCU en este momento. Por favor intentá de nuevo en unos instantes o consultá directamente en [bcu.gub.uy](https://www.bcu.gub.uy).' })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'sources', sources: [] })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      return;
    }

    // Buscar PDFs relevantes en los links encontrados en las páginas HTML
    const norm = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const queryNorm = norm(message);
    const alreadyFetched = new Set(validDocs.map(d => d.url));
    const pdfCandidates = [];

    for (const doc of validDocs) {
      if (!doc.links) continue;
      for (const link of doc.links) {
        if (!link.url.toLowerCase().includes('.pdf')) continue;
        if (alreadyFetched.has(link.url)) continue;

        const linkNorm = norm(link.text);
        let score = 0;
        const nums = message.match(/\b\d{1,4}\b/g);
        if (nums) nums.forEach(n => { if (linkNorm.includes(n)) score += 3; });
        queryNorm.split(/\s+/).forEach(w => {
          if (w.length > 3 && linkNorm.includes(w)) score += 1;
        });

        if (score > 0) {
          pdfCandidates.push({ name: link.text, url: link.url, score });
          alreadyFetched.add(link.url);
        }
      }
    }

    // Descargar los 2 PDFs más relevantes encontrados dinámicamente
    if (pdfCandidates.length > 0) {
      pdfCandidates.sort((a, b) => b.score - a.score);
      const topPDFs = pdfCandidates.slice(0, 2);
      const pdfDocs = await Promise.all(topPDFs.map(fetchBCUPage));
      pdfDocs.filter(Boolean).forEach(d => validDocs.push(d));
    }

    const docsContext = validDocs.map(doc => {
      const content = doc.isPDF
        ? extractRelevantSections(doc.content, message)
        : doc.content;
      let section = `### ${doc.name}\n**URL:** ${doc.url}\n\n${content}`;
      if (doc.links && doc.links.length > 0) {
        section += `\n\n**Documentos y enlaces encontrados:**\n${doc.links.map(l => `- ${l.text}: ${l.url}`).join('\n')}`;
      }
      return section;
    }).join('\n\n---\n\n');

    const groqMessages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history
        .filter(m => m.role && m.content)
        .map(m => ({ role: m.role, content: m.content })),
      {
        role: 'user',
        content: `Documentos oficiales del BCU para responder esta consulta (usá ÚNICAMENTE esta información):\n\n${docsContext}\n\nConsulta: ${message}`,
      },
    ];

    const stream = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: groqMessages,
      stream: true,
    });

    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content || '';
      if (text) {
        res.write(`data: ${JSON.stringify({ type: 'text', content: text })}\n\n`);
      }
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
});
