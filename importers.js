/*
 * Importazione di schede in PDF o Word (.docx).
 *
 * Entrambi i formati vengono trasformati in una sequenza di "blocchi":
 *   { type: 'p', text, size }                      paragrafo (size = altezza del testo, solo PDF)
 *   { type: 'table', rows: [[cella, ...], ...] }   tabella; ogni cella è testo con le righe separate da \n
 * che poi SchedaParser.parseBlocks trasforma nella scheda.
 */
(function (global) {
  'use strict';

  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const RE_DAY = /^(GIORNO|DAY|ALLENAMENTO|SEDUTA|WORKOUT)\s*\d+/i;
  const RE_SCHEME = /\d+\s*[x×]\s*\d+/i;
  const RE_TABLE_END = /^note\s+(per\s+la\s+)?progressione/i;

  function fileKind(buf) {
    const b = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
    if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'pdf'; // %PDF
    if (b[0] === 0x50 && b[1] === 0x4b) {
      return zipNames(buf).includes('word/document.xml') ? 'docx' : 'xlsx';
    }
    return 'other';
  }

  /* ---------------- zip minimale (per i .docx) ---------------- */
  function zipEntries(buf) {
    const v = new DataView(buf);
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 66000); i--) {
      if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return [];
    const count = v.getUint16(eocd + 10, true);
    let p = v.getUint32(eocd + 16, true);
    const out = [];
    for (let k = 0; k < count && v.getUint32(p, true) === 0x02014b50; k++) {
      const method = v.getUint16(p + 10, true);
      const csize = v.getUint32(p + 20, true);
      const nlen = v.getUint16(p + 28, true);
      const elen = v.getUint16(p + 30, true);
      const clen = v.getUint16(p + 32, true);
      const local = v.getUint32(p + 42, true);
      const name = new TextDecoder().decode(new Uint8Array(buf, p + 46, nlen));
      out.push({ name, method, csize, local });
      p += 46 + nlen + elen + clen;
    }
    return out;
  }
  const zipNames = (buf) => zipEntries(buf).map((e) => e.name);

  async function zipRead(buf, name) {
    const e = zipEntries(buf).find((x) => x.name === name);
    if (!e) throw new Error(`${name} non trovato nel file`);
    const v = new DataView(buf);
    const start = e.local + 30 + v.getUint16(e.local + 26, true) + v.getUint16(e.local + 28, true);
    const data = new Uint8Array(buf, start, e.csize);
    if (e.method === 0) return new TextDecoder().decode(data);
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).text();
  }

  /* ---------------- Word ---------------- */
  async function docxToBlocks(buf) {
    const xml = await zipRead(buf, 'word/document.xml');
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    const paraText = (p) => Array.from(p.getElementsByTagNameNS(W, 't')).map((t) => t.textContent).join('');
    const body = doc.getElementsByTagNameNS(W, 'body')[0];
    const blocks = [];
    for (const el of Array.from(body.children)) {
      if (el.localName === 'p') {
        const t = clean(paraText(el));
        if (t) blocks.push({ type: 'p', text: t });
      } else if (el.localName === 'tbl') {
        const rows = Array.from(el.children).filter((r) => r.localName === 'tr').map((tr) =>
          Array.from(tr.children).filter((c) => c.localName === 'tc').map((tc) =>
            Array.from(tc.getElementsByTagNameNS(W, 'p')).map((p) => clean(paraText(p))).filter(Boolean).join('\n')));
        blocks.push({ type: 'table', rows });
      }
    }
    return blocks;
  }

  /* ---------------- PDF ---------------- */
  let pdfjsReady = null;
  function loadPdfJs() {
    if (global.pdfjsLib) return Promise.resolve(global.pdfjsLib);
    if (!pdfjsReady) {
      pdfjsReady = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'vendor/pdf.min.js';
        s.onload = () => {
          global.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
          resolve(global.pdfjsLib);
        };
        s.onerror = () => { pdfjsReady = null; reject(new Error('impossibile caricare il lettore PDF')); };
        document.head.appendChild(s);
      });
    }
    return pdfjsReady;
  }

  /* Righe di testo di ogni pagina: [{page, y, h, items:[{x, str}]}] dall'alto verso il basso */
  async function pdfLines(buf) {
    const pdfjs = await loadPdfJs();
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
    const lines = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const tc = await page.getTextContent();
      const items = tc.items
        .filter((it) => it.str && it.str.trim())
        .map((it) => ({ x: it.transform[4], y: it.transform[5], w: it.width, h: Math.abs(it.transform[3]) || it.height, str: it.str }));
      items.sort((a, b) => b.y - a.y || a.x - b.x);
      for (const it of items) {
        const line = lines.find((l) => l.page === n && Math.abs(l.y - it.y) < 2.5);
        if (line) { line.items.push(it); line.h = Math.max(line.h, it.h); } else lines.push({ page: n, y: it.y, h: it.h, items: [it] });
      }
    }
    lines.forEach((l) => l.items.sort((a, b) => a.x - b.x));
    lines.sort((a, b) => a.page - b.page || b.y - a.y);
    return lines;
  }

  /* unisce i pezzi di testo: spazio solo se tra due pezzi c'è davvero uno spazio sulla pagina */
  function joinItems(items) {
    let out = '';
    let prevEnd = null;
    for (const it of items) {
      const gap = prevEnd == null ? 0 : it.x - prevEnd;
      if (prevEnd != null && gap > 1.2 && !/\s$/.test(out) && !/^\s/.test(it.str)) out += ' ';
      out += it.str;
      prevEnd = it.x + (it.w || 0);
    }
    return clean(out);
  }
  const lineText = (l) => joinItems(l.items);

  /* colonne della tabella dalla riga di intestazione ("Esercizio", "Serie x Ripetizioni", "Recupero", "Note...") */
  function headerColumns(line) {
    const t = lineText(line).toLowerCase();
    if (!/esercizi/.test(t) || !/(serie|ripetizioni|recupero)/.test(t)) return null;
    const starts = [];
    for (const it of line.items) {
      const s = it.str.trim().toLowerCase();
      const end = it.x + (it.w || 0);
      if (/^(esercizi|serie|ripetiz|recuper|note|carico|kg|peso|gruppo|muscol|tempo|riposo)/.test(s)
          && (!starts.length || it.x - starts[starts.length - 1].end > 8)) {
        starts.push({ x: it.x, end, items: [it] });
      } else if (starts.length) {
        const c = starts[starts.length - 1];
        c.items.push(it);
        c.end = Math.max(c.end, end);
      }
    }
    if (starts.length < 2) return null;
    // confine tra due colonne = a metà strada tra la fine di un'intestazione e l'inizio della successiva
    // (le intestazioni centrate iniziano più a destra dei dati)
    starts.forEach((c, i) => {
      c.label = joinItems(c.items);
      c.from = i === 0 ? -Infinity : (starts[i - 1].end + c.x) / 2;
    });
    return starts;
  }

  async function pdfToBlocks(buf) {
    const lines = await pdfLines(buf);
    const blocks = [];
    let table = null; // { cols, rows, recCol, cur }
    let para = null;
    const flushPara = () => { if (para) { blocks.push({ type: 'p', text: para.text, size: para.h }); para = null; } };
    const closeTable = () => { if (table) { blocks.push({ type: 'table', rows: [table.header, ...table.rows] }); table = null; } };

    for (const line of lines) {
      const text = lineText(line);
      const cols = headerColumns(line);
      if (cols) {
        flushPara(); closeTable();
        const recCol = cols.findIndex((c) => /recuper|riposo/i.test(c.label));
        table = { cols, rows: [], recCol, header: cols.map((c) => c.label), cur: null, started: false };
        continue;
      }
      if (table && (RE_DAY.test(text) || RE_TABLE_END.test(text))) closeTable();
      if (table) {
        // assegna ogni pezzo di testo alla colonna in cui inizia
        const cells = table.cols.map(() => []);
        for (const it of line.items) {
          let ci = 0;
          table.cols.forEach((c, i) => { if (it.x >= c.from) ci = i; });
          cells[ci].push(it);
        }
        const cellText = cells.map(joinItems);
        const isStart = table.recCol >= 0
          ? !!cellText[table.recCol]
          : !!cellText[0] && RE_SCHEME.test(cellText[1] || '');
        if (isStart) {
          table.cur = cellText.map((t) => (t ? [t] : []));
          table.rows.push(table.cur);
          table.started = true;
        } else if (table.started && table.cur) {
          cellText.forEach((t, i) => { if (t) table.cur[i].push(t); });
        } else if (!table.started) {
          // continuazione dell'intestazione (es. "l'esecuzione" sotto "Note per")
          cellText.forEach((t, i) => { if (t) table.header[i] += ' ' + t; });
        }
        continue;
      }
      // paragrafo: unisce le righe consecutive con lo stesso corpo del testo
      const t = text.replace(/^[•●▪\-–]\s*/, '');
      const bullet = t !== text;
      if (para && !bullet && !RE_DAY.test(t) && line.page === para.page && Math.abs(line.h - para.h) < 0.6
          && para.lastY - line.y < line.h * 1.9) {
        para.text += ' ' + t;
        para.lastY = line.y;
      } else {
        flushPara();
        para = { text: t, h: line.h, page: line.page, lastY: line.y };
      }
    }
    flushPara(); closeTable();
    // le celle tengono le righe separate da \n: servono per gli esercizi combinati ("Plank / Ellittica")
    return blocks.map((b) => (b.type === 'table'
      ? { type: 'table', rows: b.rows.map((r) => r.map((c) => (Array.isArray(c) ? c.join('\n') : c))) }
      : b));
  }

  global.SchedaImport = { fileKind, docxToBlocks, pdfToBlocks };
})(typeof window !== 'undefined' ? window : globalThis);
