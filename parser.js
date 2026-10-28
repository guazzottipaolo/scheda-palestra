/*
 * Parser della scheda di allenamento (.xlsx) -> oggetto JSON.
 *
 * Non dipende dalla posizione esatta delle celle: cerca le righe "GIORNO N",
 * l'intestazione con le colonne "SETTIMANA N", "RECUPERO", "KG ...", "NOTE",
 * e considera esercizi le righe che contengono schemi tipo "4 x 8".
 * Le righe che restano dopo l'ultimo esercizio (es. circuito cardio)
 * diventano sezioni extra.
 */
(function (global) {
  'use strict';

  const RE_DAY = /^(GIORNO|DAY|ALLENAMENTO|SEDUTA|WORKOUT)\s*[A-Z0-9]+\b/i;
  const RE_WEEK = /(?:SETTIMANA|^SETT\.?|WEEK)\s*(\d+)(.*)$/i;
  const RE_SCHEME = /\d+\s*[x×]\s*\d+/i;

  const clean = (v) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim());
  const cleanMulti = (v) =>
    v == null ? '' : String(v).split(/\r?\n/).map(clean).filter(Boolean).join('\n');
  const slug = (s) => clean(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  function cellText(cell, XLSX) {
    if (!cell || cell.v == null) return '';
    if (cell.t === 'n' && cell.z && XLSX.SSF.is_date(cell.z)) {
      const d = XLSX.SSF.parse_date_code(cell.v);
      if (d) return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
    }
    if (cell.t === 'n') return cell.w != null ? String(cell.w) : String(cell.v);
    return String(cell.v);
  }

  /* Griglia di testi con le celle unite "espanse"; origin[r][c] identifica la cella unita di provenienza. */
  function sheetToGrid(ws, XLSX) {
    if (!ws || !ws['!ref']) return { grid: [], origin: [] };
    const range = XLSX.utils.decode_range(ws['!ref']);
    const grid = [];
    const origin = [];
    for (let r = 0; r <= range.e.r; r++) {
      const row = [];
      const orow = [];
      for (let c = 0; c <= range.e.c; c++) {
        row.push(cellText(ws[XLSX.utils.encode_cell({ r, c })], XLSX).trim());
        orow.push(`${r},${c}`);
      }
      grid.push(row);
      origin.push(orow);
    }
    for (const m of ws['!merges'] || []) {
      const v = grid[m.s.r] ? grid[m.s.r][m.s.c] : '';
      for (let r = m.s.r; r <= m.e.r; r++) {
        for (let c = m.s.c; c <= m.e.c; c++) {
          if (!grid[r]) continue;
          grid[r][c] = v;
          origin[r][c] = `${m.s.r},${m.s.c}`;
        }
      }
    }
    return { grid, origin };
  }

  /* "4 x 8/10, 2 sec. pausa +" -> { sets: 4, reps: "8/10", plus: true, extra: "2 sec. pausa" } */
  function parseScheme(text) {
    const t = clean(text);
    const m = t.match(/^(\d+)\s*[x×]\s*(\d+(?:\s*[\/\-–]\s*\d+)*)\s*(.*)$/i);
    if (!m) return { sets: 0, reps: '', plus: false, extra: t, raw: t };
    let rest = m[3];
    const plus = /\+\s*$/.test(rest);
    rest = rest.replace(/\+\s*$/, '').replace(/^[,;\s]+/, '').trim();
    return { sets: parseInt(m[1], 10), reps: m[2].replace(/\s+/g, ''), plus, extra: rest, raw: t };
  }

  /* "90 sec." -> 90, "2 MIN" -> 120, "1 MINUTO" -> 60, "1'30" -> 90, 90" / 90'' / 90” -> 90 */
  function parseDuration(text) {
    const t = clean(text).toLowerCase()
      .replace(/(\d)\s*(?:''|’’|”|″|")/g, '$1 sec'); // doppio apice = secondi
    if (!t) return 0;
    let m = t.match(/(\d+)\s*['’′]\s*(\d+)?/);
    if (m) return parseInt(m[1], 10) * 60 + (m[2] ? parseInt(m[2], 10) : 0);
    let sec = 0;
    let found = false;
    m = t.match(/(\d+(?:[.,]\d+)?)\s*(?:min|minut|m\b)/);
    if (m) { sec += parseFloat(m[1].replace(',', '.')) * 60; found = true; }
    m = t.match(/(\d+)\s*(?:sec|s\b|")/);
    if (m) { sec += parseInt(m[1], 10); found = true; }
    if (!found) {
      m = t.match(/^(\d+)$/);
      if (m) sec = parseInt(m[1], 10);
    }
    return Math.round(sec);
  }

  /* Primo numero di un testo: "12.5kg per lato" -> 12.5 */
  function firstNumber(text) {
    const m = clean(text).match(/\d+(?:[.,]\d+)?/);
    return m ? parseFloat(m[0].replace(',', '.')) : null;
  }

  function firstCell(row) {
    for (let c = 0; c < row.length; c++) {
      const v = clean(row[c]);
      if (v) return { c, v };
    }
    return null;
  }

  function mapHeader(hdr) {
    const cols = { group: -1, name: -1, weeks: [], rest: -1, kg: [], note: -1 };
    const seenWeeks = new Set();
    const seenKg = new Set();
    hdr.forEach((v, c) => {
      const t = clean(v).toUpperCase();
      if (!t) return;
      let m;
      if (!/\bKG\b/.test(t) && (m = t.match(RE_WEEK))) {
        const n = parseInt(m[1], 10);
        if (seenWeeks.has(n)) return;
        seenWeeks.add(n);
        cols.weeks.push({ col: c, n, label: clean(m[2]) });
      } else if (/\bKG\b|PESO|^CARICO/.test(t)) {
        if (seenKg.has(t)) return;
        seenKg.add(t);
        const n = t.match(/(\d+)/);
        cols.kg.push({ col: c, from: n ? parseInt(n[1], 10) : 1, label: clean(v) });
      } else if (/RECUPERO|\bREST\b|RIPOSO/.test(t)) {
        if (cols.rest < 0) cols.rest = c;
      } else if (/^NOT[AE]|CONSIGL/.test(t)) {
        if (cols.note < 0) cols.note = c;
      } else if (/ESERCIZI/.test(t)) {
        if (cols.name < 0) cols.name = c;
      } else if (/GRUPPO|MUSCOL|DISTRETTO/.test(t)) {
        if (cols.group < 0) cols.group = c;
        else if (cols.name < 0 && c !== cols.group) cols.name = c;
      }
    });
    if (cols.name < 0) cols.name = cols.group >= 0 ? cols.group + 1 : 0;
    if (cols.group < 0) cols.group = cols.name > 0 ? cols.name - 1 : -1;
    cols.kg.sort((a, b) => a.from - b.from);
    cols.weeks.sort((a, b) => a.n - b.n);
    return cols;
  }

  function isHeaderText(t) {
    return /^(GRUPPO MUSCOLARE|ESERCIZIO|ESERCIZI)$/i.test(clean(t));
  }

  function parseGrid(grid, origin) {
    const dayRows = [];
    grid.forEach((row, r) => {
      const f = firstCell(row);
      if (f && f.v.length < 40 && RE_DAY.test(f.v)) dayRows.push({ r, title: f.v, c: f.c });
    });

    const result = { title: '', meta: { fields: [], texts: [] }, weeks: 0, weekLabels: {}, days: [], extras: [] };
    if (!dayRows.length) return result;

    // --- intestazione (righe prima del primo giorno) ---
    const seenTexts = new Set();
    for (let r = 0; r < dayRows[0].r; r++) {
      const row = grid[r];
      const used = new Set();
      for (let c = 0; c < row.length; c++) {
        if (used.has(c)) continue;
        const raw = row[c];
        const v = clean(raw);
        if (!v) continue;
        // celle unite orizzontali: salta i duplicati sulla stessa riga
        let k = c + 1;
        while (k < row.length && origin[r][k] === origin[r][c]) used.add(k++);
        const lm = v.match(/^([^:\n]{2,40}):$/);
        if (lm) {
          let val = '';
          for (let j = k; j < row.length; j++) {
            const w = clean(row[j]);
            if (w && origin[r][j] !== origin[r][c]) {
              val = w;
              let q = j;
              while (q < row.length && origin[r][q] === origin[r][j]) used.add(q++);
              break;
            }
          }
          if (val) result.meta.fields.push({ label: clean(lm[1]), value: val });
        } else if (!result.title) {
          result.title = v;
        } else {
          const t = cleanMulti(raw);
          if (!seenTexts.has(t)) { seenTexts.add(t); result.meta.texts.push(t); }
        }
      }
    }

    // --- giorni ---
    const leftovers = []; // righe non usate dopo l'ultimo esercizio di ogni giorno
    let cols = null;
    dayRows.forEach((d, i) => {
      const end = i + 1 < dayRows.length ? dayRows[i + 1].r : grid.length;
      const day = { title: d.title, notes: [], weekLabels: {}, exercises: [] };

      // note sulla riga del titolo (es. "SCRIVI QUANTE RIPETIZIONI HAI FATTO...")
      const seen = new Set([d.title]);
      grid[d.r].forEach((v) => {
        const t = clean(v);
        if (t && !seen.has(t)) {
          seen.add(t);
          if (!/:$/.test(t)) day.notes.push(t);
        }
      });

      // riga di intestazione
      let hdrRow = -1;
      for (let r = d.r + 1; r < Math.min(end, d.r + 5); r++) {
        if (grid[r].some((v) => /SETTIMANA\s*\d+|WEEK\s*\d+/i.test(v))) { hdrRow = r; break; }
      }
      if (hdrRow >= 0) cols = mapHeader(grid[hdrRow]);
      if (!cols) return;
      const start = hdrRow >= 0 ? hdrRow + 1 : d.r + 1;

      // etichette sotto le settimane (STESSO CARICO, AUMENTO CARICO, SCARICO...)
      for (const w of cols.weeks) {
        const labels = [];
        if (w.label) labels.push(w.label);
        for (let r = start; r < Math.min(end, start + 2); r++) {
          const t = clean(grid[r][w.col]);
          const h = hdrRow >= 0 ? clean(grid[hdrRow][w.col]) : '';
          if (t && t !== h && !RE_SCHEME.test(t) && !labels.includes(t)) labels.push(t);
          if (grid[r].some((v) => RE_SCHEME.test(v))) break;
        }
        if (labels.length) day.weekLabels[w.n] = labels.join(' · ');
      }

      let lastGroup = '';
      let lastDataRow = start - 1;
      for (let r = start; r < end; r++) {
        const row = grid[r];
        const name = clean(row[cols.name]);
        const isData = name && !isHeaderText(name) && cols.weeks.some((w) => RE_SCHEME.test(row[w.col]));
        if (!isData) continue;
        lastDataRow = r;
        const g = cols.group >= 0 ? clean(row[cols.group]) : '';
        if (g && !isHeaderText(g)) lastGroup = g;
        const weeks = {};
        cols.weeks.forEach((w) => { const t = clean(row[w.col]); if (t) weeks[w.n] = t; });
        const restText = cols.rest >= 0 ? clean(row[cols.rest]) : '';
        const ex = {
          id: `d${i + 1}-${slug(name)}-${day.exercises.length + 1}`,
          group: lastGroup || 'ESERCIZI',
          name,
          weeks,
          rest: restText,
          restSec: parseDuration(restText),
          kg: cols.kg
            .map((k) => ({ from: k.from, label: k.label, text: clean(row[k.col]) }))
            .filter((k) => k.text),
          note: cols.note >= 0 ? cleanMulti(row[cols.note]) : '',
        };
        day.exercises.push(ex);
      }
      for (let r = lastDataRow + 1; r < end; r++) leftovers.push(r);

      cols.weeks.forEach((w) => { result.weeks = Math.max(result.weeks, w.n); });
      Object.entries(day.weekLabels).forEach(([n, l]) => {
        if (!result.weekLabels[n]) result.weekLabels[n] = l;
      });
      if (day.exercises.length) result.days.push(day);
    });

    // --- sezioni extra (cardio, ecc.) ---
    const nameCol = cols ? cols.name : 1;
    const titleCol = cols && cols.group >= 0 ? cols.group : 0;
    const sections = [];
    let cur = null;
    for (const r of leftovers) {
      const row = grid[r];
      const title = clean(row[titleCol]);
      const name = clean(row[nameCol]);
      if (!title && !name) continue;
      if (title && (!cur || cur.title !== title)) {
        cur = { title, rows: [] };
        sections.push(cur);
      }
      if (!cur || !name) continue;
      const nameOrigin = origin[r][nameCol];
      if (cur.rows.some((x) => x.nameOrigin === nameOrigin)) continue; // stessa cella unita
      const details = [];
      for (let c = 0; c < row.length; c++) {
        if (c === titleCol || c === nameCol) continue;
        const t = clean(row[c]);
        if (!t) continue;
        if (c > 0 && origin[r][c] === origin[r][c - 1]) continue;
        details.push({ text: t, origin: origin[r][c] });
      }
      cur.rows.push({ name, nameOrigin, details });
    }
    for (const s of sections) {
      if (!s.rows.length) continue;
      // un valore che arriva dalla stessa cella unita su più esercizi è una nota di sezione
      const count = {};
      s.rows.forEach((x) => new Set(x.details.map((d) => d.origin)).forEach((o) => { count[o] = (count[o] || 0) + 1; }));
      const notes = [];
      const items = s.rows.map((x) => {
        const own = [];
        x.details.forEach((d) => {
          if (s.rows.length > 1 && count[d.origin] > 1) {
            if (!notes.includes(d.text)) notes.push(d.text);
          } else own.push(d.text);
        });
        const dur = own.map(parseDuration).find((n) => n > 0) || 0;
        return { name: x.name, details: own, durationSec: dur };
      });
      result.extras.push({ title: s.title, notes, items });
    }

    if (!result.title) result.title = 'Scheda di allenamento';
    return result;
  }

  /* Ritorna un array di schede (una per foglio che contiene giorni di allenamento). */
  function parseWorkbook(wb, XLSX) {
    const out = [];
    for (const name of wb.SheetNames) {
      const { grid, origin } = sheetToGrid(wb.Sheets[name], XLSX);
      const res = parseGrid(grid, origin);
      if (res.days.length) {
        res.sheetName = name;
        out.push(res);
      }
    }
    return out;
  }

  /*
   * Schede in PDF o Word: paragrafi + una tabella per giorno
   * (colonne tipo Esercizio | Serie x Ripetizioni | Recupero | Note).
   * Lo schema vale per tutte le settimane; la progressione è scritta a parole
   * ("Settimane 3-4: aumenta leggermente il carico") e diventa una nota per settimana.
   */
  const RE_KG = /(\d+(?:[.,]\d+)?)\s*kg\b\.?(\s*(?:per\s+lato|per\s+gamba|per\s+braccio|totali|totale|a\s+manubrio))?/i;

  function tableColumns(header) {
    const cols = { name: -1, scheme: -1, rest: -1, note: -1, kg: -1, group: -1 };
    header.forEach((h, i) => {
      const t = clean(h).toLowerCase();
      if (cols.name < 0 && /esercizi/.test(t)) cols.name = i;
      else if (cols.scheme < 0 && /(serie|ripetiz)/.test(t)) cols.scheme = i;
      else if (cols.rest < 0 && /(recuper|riposo|pausa)/.test(t)) cols.rest = i;
      else if (cols.note < 0 && /(note|esecuzion|consigl)/.test(t)) cols.note = i;
      else if (cols.kg < 0 && /(\bkg\b|carico|peso)/.test(t)) cols.kg = i;
      else if (cols.group < 0 && /(gruppo|muscol|distretto)/.test(t)) cols.group = i;
    });
    if (cols.name < 0) cols.name = 0;
    if (cols.scheme < 0) cols.scheme = cols.name + 1;
    return cols;
  }

  function rowToExercise(row, cols, dayIdx, k) {
    const cell = (i) => (i >= 0 && row[i] ? String(row[i]) : '');
    const name0 = clean(cell(cols.name)).replace(/\s*\/\s*/g, ' / ');
    if (!name0) return null;
    const schemeCell = cell(cols.scheme);
    const lines = schemeCell.split('\n').map(clean).filter(Boolean);
    const restText = clean(cell(cols.rest));
    const ex = {
      id: `d${dayIdx}-${slug(name0)}-${k}`,
      group: clean(cell(cols.group)),
      name: name0,
      weeks: {},
      rest: restText,
      restSec: parseDuration(restText),
      kg: [],
      note: clean(cell(cols.note).replace(/\n/g, ' ')).replace(/\s+([.,;])/g, '$1').replace(/^[.\s]+$/, ''),
    };
    const parts = name0.split('/').map(clean).filter(Boolean);
    const joined = clean(lines.join(' '));
    if (!RE_SCHEME.test(joined)) {
      // esercizi a tempo o combinati: "Plank / Ellittica" con "1 minuto di plank" e "2 min di ellittica"
      const pairs = parts.length > 1 && lines.length === parts.length
        ? parts.map((n, i) => ({ name: n, text: lines[i] }))
        : [{ name: name0, text: joined }];
      ex.items = pairs.map((p) => ({ name: p.name, text: p.text, sec: parseDuration(p.text) }));
      ex.weeks[1] = pairs.map((p) => p.text).join(' · ');
      return ex;
    }
    // il carico può stare nella cella dello schema ("4 x 10/12 20 kg per lato") o in una colonna sua
    let scheme = joined;
    let kgText = clean(cell(cols.kg));
    const m = scheme.match(RE_KG);
    if (m) {
      if (!kgText) kgText = clean(m[0]).replace(/\.$/, '');
      scheme = clean(scheme.replace(m[0], ' '));
    }
    ex.weeks[1] = scheme;
    if (kgText) ex.kg.push({ from: 1, label: 'Carico', text: kgText });
    // "Shoulder press 10 kg": il carico ripetuto nel nome si toglie
    const nm = ex.name.replace(new RegExp('\\s*' + RE_KG.source + '\\s*$', 'i'), '');
    if (nm && nm !== ex.name) ex.name = clean(nm);
    return ex;
  }

  function parseBlocks(blocks) {
    const result = { title: '', meta: { fields: [], texts: [] }, weeks: 0, weekLabels: {}, weekNotes: [], days: [], extras: [] };
    let pendingDay = null;
    for (const b of blocks) {
      if (b.type === 'p') {
        const t = clean(b.text);
        let m;
        if ((m = t.match(/^(?:giorno|day|allenamento|seduta|workout)\s*(\d+)\s*(?:[-–:]\s*(.+))?$/i))) {
          pendingDay = { title: `GIORNO ${m[1]}`, subtitle: clean(m[2] || '') };
        } else if ((m = t.match(/^settiman[ae]\s*(\d+)\s*(?:[-–]|a|e)\s*(\d+)\s*[:.]\s*(.+)$/i))) {
          result.weekNotes.push({ from: +m[1], to: +m[2], text: clean(m[3]) });
        } else if ((m = t.match(/^settimana\s*(\d+)\s*[:.]\s*(.+)$/i))) {
          result.weekNotes.push({ from: +m[1], to: +m[1], text: clean(m[2]) });
        } else if (/^note\s+(per\s+la\s+)?progressione\s*:?$/i.test(t)) {
          // titolo della lista di progressione
        } else if (!result.title) {
          result.title = t;
        } else {
          result.meta.texts.push(t.replace(/\s+:/g, ':'));
        }
        continue;
      }
      if (b.type !== 'table' || b.rows.length < 2) continue;
      const cols = tableColumns(b.rows[0]);
      const dayIdx = result.days.length + 1;
      const day = {
        title: pendingDay ? pendingDay.title : `GIORNO ${dayIdx}`,
        subtitle: pendingDay ? pendingDay.subtitle : '',
        notes: [],
        weekLabels: {},
        exercises: [],
      };
      pendingDay = null;
      b.rows.slice(1).forEach((r) => {
        const ex = rowToExercise(r, cols, dayIdx, day.exercises.length + 1);
        if (ex) day.exercises.push(ex);
      });
      if (day.exercises.length) result.days.push(day);
    }
    const tw = result.title.match(/(\d+)\s*settiman/i);
    result.weeks = tw ? +tw[1] : Math.max(1, ...result.weekNotes.map((n) => n.to));
    if (!result.title) result.title = 'Scheda di allenamento';
    return result;
  }

  global.SchedaParser = { parseWorkbook, parseBlocks, parseScheme, parseDuration, firstNumber };
})(typeof window !== 'undefined' ? window : globalThis);
