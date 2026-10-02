(function () {
  'use strict';

  const P = window.SchedaParser;
  const app = document.getElementById('app');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const keyOf = (name) => String(name).toLowerCase().replace(/\s+/g, ' ').trim();
  const fmtDate = (d) => new Date(d).toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' });
  const fmtNum = (n) => (n == null || n === '' ? '' : String(n).replace('.', ','));

  /* ================= memoria ================= */
  const store = {
    get(k, def) {
      try { const v = localStorage.getItem('gp.' + k); return v == null ? def : JSON.parse(v); } catch (e) { return def; }
    },
    set(k, v) {
      try { localStorage.setItem('gp.' + k, JSON.stringify(v)); } catch (e) { toast('Impossibile salvare i dati'); }
    },
    del(k) { try { localStorage.removeItem('gp.' + k); } catch (e) { /* ignora */ } },
  };
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  /* Foto/video degli esercizi in IndexedDB (troppo grandi per localStorage) */
  const mediaDB = {
    db: null,
    open() {
      if (this.db) return Promise.resolve(this.db);
      return new Promise((res, rej) => {
        const req = indexedDB.open('scheda-media', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('media');
        req.onsuccess = () => { this.db = req.result; res(this.db); };
        req.onerror = () => rej(req.error);
      });
    },
    async tx(mode, fn) {
      const db = await this.open();
      return new Promise((res, rej) => {
        const t = db.transaction('media', mode);
        const r = fn(t.objectStore('media'));
        t.oncomplete = () => res(r && r.result);
        t.onerror = () => rej(t.error);
      });
    },
    get(k) { return this.tx('readonly', (s) => s.get(k)); },
    put(k, v) { return this.tx('readwrite', (s) => s.put(v, k)); },
    del(k) { return this.tx('readwrite', (s) => s.delete(k)); },
  };

  let scheda = store.get('scheda', null);
  let session = store.get('session', null);
  let history = store.get('history', []);
  let links = store.get('links', {});
  let allProgress = store.get('progress', {});
  let view = { name: 'home' };
  let pendingSchede = null; // più fogli nello stesso file: scelta dell'utente

  function prog() {
    const k = scheda.title;
    if (!allProgress[k]) allProgress[k] = { week: 1, done: {} };
    return allProgress[k];
  }
  const saveProg = () => store.set('progress', allProgress);
  const saveSession = () => store.set('session', session);

  /* ================= utilità scheda ================= */
  const weekLabel = (w, day) => (day && day.weekLabels[w]) || scheda.weekLabels[w] || '';
  const groupsOf = (day) => [...new Set(day.exercises.map((e) => e.group))];

  function schemeFor(ex, w) {
    // se la settimana non è indicata, usa l'ultima disponibile precedente
    for (let k = w; k >= 1; k--) if (ex.weeks[k]) return ex.weeks[k];
    return ex.weeks[Object.keys(ex.weeks)[0]] || '';
  }
  function kgFor(ex, w) {
    let cur = null;
    ex.kg.forEach((k) => { if (k.from <= w) cur = k; });
    return cur || ex.kg[0] || null;
  }
  function lastTime(name) {
    const k = keyOf(name);
    for (let i = history.length - 1; i >= 0; i--) {
      const e = history[i].exercises.find((x) => keyOf(x.name) === k && x.sets.length);
      if (e) return { h: history[i], e };
    }
    return null;
  }
  function nextDayIndex() {
    const p = prog();
    const done = p.done[p.week] || [];
    const i = scheda.days.findIndex((_, idx) => !done.includes(idx));
    return i;
  }

  /* ================= navigazione ================= */
  function go(name, params) {
    view = Object.assign({ name }, params || {});
    if (name !== 'home') history_push();
    render();
    window.scrollTo(0, 0);
  }
  function history_push() { try { window.history.pushState({ v: view.name }, ''); } catch (e) { /* ignora */ } }
  window.addEventListener('popstate', () => {
    view = { name: 'home' };
    render();
  });

  /* ================= render ================= */
  function render() {
    updateWakeLock();
    if (pendingSchede) return renderChoose();
    if (!scheda) return renderEmpty();
    switch (view.name) {
      case 'workout': return session ? renderWorkout() : (view = { name: 'home' }, renderHome());
      case 'extra': return renderExtra();
      case 'history': return renderHistory();
      case 'info': return renderInfo();
      default: return renderHome();
    }
  }

  function renderEmpty() {
    app.innerHTML = `
      <div class="empty">
        <div class="logo">🏋️</div>
        <h1>La tua scheda, in palestra</h1>
        <p class="muted">Carica il file della scheda che ti ha condiviso il trainer.</p>
        <ol class="steps">
          <li>Tocca <b>Carica scheda</b></li>
          <li>Nel selettore scegli <b>Drive</b> (dal menu ☰) oppure la cartella <b>Download</b></li>
          <li>Seleziona il file della scheda</li>
        </ol>
        <p class="small muted" style="text-align:left">Se non si apre: nell'app <b>Drive</b> tocca ⋮ accanto alla scheda → <b>Scarica</b>, poi qui scegli il file dalla cartella <b>Download</b>.</p>
        <button class="btn btn-primary btn-block" data-act="import">Carica scheda</button>
        <p class="small muted" style="margin-top:22px">Hai un backup? <a href="#" data-act="restore">Ripristina dati</a></p>
      </div>`;
  }

  function renderChoose() {
    app.innerHTML = `
      <div class="top"><h1>Quale scheda?</h1></div>
      <p class="muted">Il file contiene più fogli con un allenamento. Scegli quello da usare:</p>
      <div class="day-list">
        ${pendingSchede.map((s, i) => `
          <button class="day-item" data-act="choose" data-i="${i}">
            <div class="grow"><div class="title">${esc(s.sheetName)}</div>
            <div class="muted small">${esc(s.title)} · ${s.days.length} giorni</div></div>
          </button>`).join('')}
      </div>
      <p><button class="btn btn-block" data-act="choose-cancel" style="margin-top:16px">Annulla</button></p>`;
  }

  function renderHome() {
    const p = prog();
    const w = p.week;
    const doneW = p.done[w] || [];
    const next = nextDayIndex();
    const label = weekLabel(w);
    let hero;
    if (session && session.scheda === scheda.title && scheda.days[session.day]) {
      const day = scheda.days[session.day];
      const n = day.exercises.filter((e) => exState(e).done).length;
      hero = `
        <div class="card hero">
          <div class="eyebrow">Allenamento in corso · Sett. ${session.week}</div>
          <h2>${esc(day.title)}</h2>
          <div class="muted">${n} di ${day.exercises.length} esercizi completati</div>
          <button class="btn btn-primary btn-block" data-act="resume">Riprendi</button>
          <button class="btn btn-block btn-small btn-danger" style="margin-top:8px" data-act="abort">Annulla allenamento</button>
        </div>`;
    } else if (next >= 0) {
      const day = scheda.days[next];
      hero = `
        <div class="card hero">
          <div class="eyebrow">Prossimo allenamento</div>
          <h2>${esc(day.title)}</h2>
          <div class="chips">${groupsOf(day).map((g) => `<span class="chip">${esc(g)}</span>`).join('')}</div>
          <button class="btn btn-primary btn-block" data-act="start" data-day="${next}">Inizia</button>
        </div>`;
    } else {
      hero = `
        <div class="card hero">
          <div class="eyebrow">Settimana ${w}</div>
          <h2>Completata! 💪</h2>
          <div class="muted">${w < scheda.weeks ? 'Passa alla settimana successiva con la freccia ›' : 'Hai finito la scheda: chiedi al trainer quella nuova e caricala.'}</div>
        </div>`;
    }

    app.innerHTML = `
      <header class="top">
        <div style="flex:1;min-width:0">
          <div class="eyebrow">Scheda</div>
          <h1>${esc(scheda.title)}</h1>
        </div>
        <button class="icon-btn" data-act="go" data-view="info" aria-label="Info scheda">⚙︎</button>
      </header>

      <div class="card week">
        <button class="icon-btn" data-act="week" data-d="-1" aria-label="Settimana precedente" ${w <= 1 ? 'disabled' : ''}>‹</button>
        <div class="week-mid">
          <div class="eyebrow">Settimana</div>
          <div class="week-num">${w} <span class="muted" style="font-size:1rem;font-weight:500">/ ${scheda.weeks}</span></div>
          <div class="week-label">${esc(label)}</div>
        </div>
        <button class="icon-btn" data-act="week" data-d="1" aria-label="Settimana successiva" ${w >= scheda.weeks ? 'disabled' : ''}>›</button>
      </div>

      ${hero}

      <div class="section-title">Giorni · settimana ${w}</div>
      <div class="day-list">
        ${scheda.days.map((d, i) => `
          <button class="day-item" data-act="start" data-day="${i}">
            <span class="check ${doneW.includes(i) ? 'on' : ''}">✓</span>
            <div class="grow">
              <div class="title">${esc(d.title)}</div>
              <div class="muted small">${groupsOf(d).map(esc).join(' · ')}</div>
            </div>
            <span class="muted">›</span>
          </button>`).join('')}
      </div>

      ${scheda.extras.length ? `
        <div class="section-title">Extra</div>
        <div class="day-list">
          ${scheda.extras.map((x, i) => `
            <button class="day-item" data-act="go" data-view="extra" data-i="${i}">
              <span style="font-size:1.4rem">🔥</span>
              <div class="grow"><div class="title">${esc(x.title)}</div>
              <div class="muted small">${x.items.map((it) => esc(it.name)).join(' · ')}</div></div>
              <span class="muted">›</span>
            </button>`).join('')}
        </div>` : ''}

      <div class="section-title">Altro</div>
      <div class="row">
        <button class="btn" data-act="go" data-view="history">📈 Storico</button>
        <button class="btn" data-act="import">📄 Carica scheda</button>
      </div>`;
  }

  /* ---------- allenamento ---------- */
  function exState(ex) {
    if (!session.ex[ex.id]) {
      const sch = P.parseScheme(schemeFor(ex, session.week));
      const n = Math.max(1, sch.sets || 1);
      const ref = kgFor(ex, session.week);
      const lt = lastTime(ex.name);
      let kg = ref ? P.firstNumber(ref.text) : null;
      if (kg == null && lt) kg = lt.e.sets[lt.e.sets.length - 1].kg;
      session.ex[ex.id] = {
        done: false,
        sets: Array.from({ length: n }, () => ({ kg: kg == null ? '' : kg, reps: '', done: false })),
      };
    }
    return session.ex[ex.id];
  }

  function renderWorkout() {
    const day = scheda.days[session.day];
    const w = session.week;
    if (!session.open) {
      const first = day.exercises.find((e) => !exState(e).done);
      session.open = first ? first.id : null;
    }
    const groups = groupsOf(day);
    const nDone = day.exercises.filter((e) => exState(e).done).length;

    app.innerHTML = `
      <header class="top">
        <button class="icon-btn" data-act="home" aria-label="Indietro">‹</button>
        <div style="flex:1;min-width:0">
          <div class="eyebrow">Settimana ${w}${weekLabel(w, day) ? ' · ' + esc(weekLabel(w, day)) : ''}</div>
          <h1>${esc(day.title)} <span class="muted" style="font-weight:500;font-size:1rem">${nDone}/${day.exercises.length}</span></h1>
        </div>
      </header>
      ${day.notes.map((n) => `<div class="note">${esc(n)}</div>`).join('')}
      ${groups.map((g) => {
        const exs = day.exercises.filter((e) => e.group === g);
        const gDone = exs.every((e) => exState(e).done);
        return `
          <section class="group ${gDone ? 'done' : ''}">
            <div class="group-head">
              <h2>${esc(g)}</h2>
              <button class="check ${gDone ? 'on' : ''}" data-act="group" data-g="${esc(g)}" aria-label="Segna ${esc(g)} come completato">✓</button>
            </div>
            ${exs.map((e) => renderExercise(e, w)).join('')}
          </section>`;
      }).join('')}
      <div style="margin-top:24px">
        <button class="btn btn-primary btn-block" data-act="finish">✓ Concludi ${esc(day.title)}</button>
      </div>
      ${scheda.extras.length ? `<div class="row" style="margin-top:10px">${scheda.extras.map((x, i) =>
        `<button class="btn btn-small" data-act="go" data-view="extra" data-i="${i}">🔥 ${esc(x.title)}</button>`).join('')}</div>` : ''}`;

    loadMediaInto();
  }

  function renderExercise(ex, w) {
    const st = exState(ex);
    const open = session.open === ex.id;
    const raw = schemeFor(ex, w);
    const sch = P.parseScheme(raw);
    const ref = kgFor(ex, w);
    const doneSets = st.sets.filter((s) => s.done).length;
    const schemeHtml = sch.sets
      ? `${sch.sets} × ${esc(sch.reps)}${sch.plus ? '<span class="plus">+</span>' : ''}`
      : esc(raw);

    let body = '';
    if (open) {
      const lt = lastTime(ex.name);
      const others = ex.kg.filter((k) => k !== ref);
      body = `
        <div class="ex-body">
          ${ex.note ? `<div class="note">💡 ${esc(ex.note)}</div>` : ''}
          ${sch.plus ? `<div class="plus-hint">➕ Ultima serie: fai più ripetizioni che puoi e annota quante.</div>` : ''}
          <div class="facts">
            ${ref ? `<div class="fact"><span>${esc(ref.label || 'Carico')}</span><b>${esc(ref.text)}</b></div>` : ''}
            ${others.map((k) => `<div class="fact"><span>${esc(k.label)}</span><b class="muted">${esc(k.text)}</b></div>`).join('')}
            ${ex.rest ? `<div class="fact"><span>Recupero</span><b>${esc(ex.rest)}</b></div>` : ''}
          </div>
          ${lt ? `<div class="last">🕘 Ultima volta (${fmtDate(lt.h.date)}, sett. ${lt.h.week}): ${lt.e.sets.map((s) => `${fmtNum(s.kg) || '–'}kg×${s.reps || '–'}`).join(' · ')}</div>` : ''}
          <div class="sets">
            ${st.sets.map((s, i) => `
              <div class="set ${s.done ? 'done' : ''} ${sch.plus && i === st.sets.length - 1 ? 'amrap' : ''}" data-i="${i}">
                <div class="set-n">${i + 1}${sch.plus && i === st.sets.length - 1 ? '+' : ''}</div>
                <label><input type="text" inputmode="decimal" data-f="kg" data-id="${ex.id}" data-i="${i}" value="${esc(fmtNum(s.kg))}" aria-label="Kg serie ${i + 1}"><small>kg</small></label>
                <label><input type="text" inputmode="numeric" data-f="reps" data-id="${ex.id}" data-i="${i}" value="${esc(s.reps)}" placeholder="${esc(sch.reps.split(/[\/\-–]/)[0] || '')}" aria-label="Ripetizioni serie ${i + 1}"><small>rip</small></label>
                <button class="set-ok" data-act="set" data-id="${ex.id}" data-i="${i}" aria-label="Serie ${i + 1} fatta">✓</button>
              </div>`).join('')}
          </div>
          <div class="row ex-actions">
            ${ex.restSec ? `<button class="btn btn-small" data-act="rest" data-s="${ex.restSec}">⏱ Recupero ${ex.restSec}s</button>` : ''}
            <button class="btn btn-small" data-act="exdone" data-id="${ex.id}">${st.done ? 'Riapri' : 'Esercizio fatto'}</button>
          </div>
          ${renderHow(ex.name)}
        </div>`;
    }

    return `
      <article class="ex ${open ? 'open' : ''} ${st.done ? 'done' : ''}" id="ex-${ex.id}">
        <button class="ex-head" data-act="toggle" data-id="${ex.id}">
          <div class="ex-name">${esc(ex.name)} ${st.done ? '<span class="ex-done-badge">✓ fatto</span>' : ''}</div>
          <div class="ex-line">
            <span class="ex-scheme">${schemeHtml}</span>
            ${ref ? `<span class="ex-kg">${esc(ref.text)}</span>` : ''}
          </div>
          ${sch.extra && sch.sets ? `<div class="ex-extra">${esc(sch.extra)}</div>` : ''}
          <div class="dots">${st.sets.map((s) => `<i class="${s.done ? 'on' : ''}"></i>`).join('')}</div>
        </button>
        ${body}
      </article>`;
  }

  /* ---------- "come si fa": video e foto ---------- */
  function renderHow(name, titled) {
    const k = keyOf(name);
    const link = links[k];
    const yt = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(name.toLowerCase() + ' esecuzione corretta');
    return `
      <div class="how">
        <h3>Come si fa${titled ? ' · ' + esc(name) : ''}</h3>
        <div class="media" data-media="${esc(k)}"></div>
        <div class="row">
          ${link ? `<a class="btn btn-small btn-primary" href="${esc(link)}" target="_blank" rel="noopener">▶ Il tuo video</a>` : ''}
          <a class="btn btn-small" href="${esc(yt)}" target="_blank" rel="noopener">🔎 Cerca su YouTube</a>
        </div>
        <div class="row" style="margin-top:8px">
          <button class="btn btn-small" data-act="link" data-k="${esc(k)}">🔗 ${link ? 'Cambia link' : 'Link video'}</button>
          <button class="btn btn-small" data-act="media" data-k="${esc(k)}">📷 Foto/video</button>
        </div>
      </div>`;
  }

  const mediaUrls = {};
  async function loadMediaInto() {
    const boxes = app.querySelectorAll('[data-media]');
    for (const box of boxes) {
      const k = box.dataset.media;
      let rec;
      try { rec = await mediaDB.get(k); } catch (e) { rec = null; }
      if (!rec) { box.innerHTML = ''; continue; }
      if (!mediaUrls[k]) mediaUrls[k] = URL.createObjectURL(rec.blob);
      const url = mediaUrls[k];
      box.innerHTML = (rec.blob.type.startsWith('video')
        ? `<video src="${url}" controls playsinline loop muted></video>`
        : `<img src="${url}" alt="Esecuzione ${esc(k)}">`) +
        `<button class="btn btn-small btn-danger" style="margin-top:6px" data-act="media-del" data-k="${esc(k)}">Rimuovi</button>`;
    }
  }

  /* ---------- extra (cardio) ---------- */
  function renderExtra() {
    const x = scheda.extras[view.i];
    if (!x) { view = { name: 'home' }; return renderHome(); }
    app.innerHTML = `
      <header class="top">
        <button class="icon-btn" data-act="back" aria-label="Indietro">‹</button>
        <h1>${esc(x.title)}</h1>
      </header>
      ${x.notes.length ? `<div class="note">${x.notes.map(esc).join(' · ')}</div>` : ''}
      <div class="card">
        ${x.items.map((it, i) => `
          <div class="extra-item">
            <div class="grow">
              <div style="font-weight:700">${esc(it.name)}</div>
              <div class="muted">${it.details.map(esc).join(' · ')}</div>
            </div>
            ${it.durationSec ? `<button class="play" data-act="extra-timer" data-i="${i}" aria-label="Avvia timer">▶</button>` : ''}
          </div>`).join('')}
      </div>
      ${x.items.map((it) => renderHow(it.name, true)).join('')}`;
    loadMediaInto();
  }

  /* ---------- storico ---------- */
  function renderHistory() {
    const items = history.slice().reverse();
    app.innerHTML = `
      <header class="top">
        <button class="icon-btn" data-act="back" aria-label="Indietro">‹</button>
        <h1>Storico</h1>
      </header>
      ${items.length ? items.map((h) => `
        <details class="hist">
          <summary>
            <div style="font-weight:700">${esc(h.dayTitle)} · sett. ${h.week}</div>
            <div class="muted small">${fmtDate(h.date)} · ${esc(h.scheda)}</div>
          </summary>
          <div class="body">
            ${h.exercises.map((e) => `
              <div class="hist-ex">
                <b>${esc(e.name)}</b>
                <span class="muted small">${esc(e.scheme)}</span>
                <div>${e.sets.length ? e.sets.map((s) => `${fmtNum(s.kg) || '–'}kg × ${s.reps || '–'}`).join(' · ') : '<span class="muted">segnato come fatto</span>'}</div>
              </div>`).join('')}
          </div>
        </details>`).join('') : '<p class="muted">Nessun allenamento concluso ancora.</p>'}`;
  }

  /* ---------- info e gestione dati ---------- */
  function renderInfo() {
    const m = scheda.meta;
    app.innerHTML = `
      <header class="top">
        <button class="icon-btn" data-act="back" aria-label="Indietro">‹</button>
        <h1>Scheda e dati</h1>
      </header>
      <div class="card">
        <h2 style="font-size:1.1rem;margin-bottom:12px">${esc(scheda.title)}</h2>
        <dl class="fields">
          ${m.fields.map((f) => `<dt>${esc(f.label)}</dt><dd>${esc(/^\d{4}-\d{2}-\d{2}$/.test(f.value) ? new Date(f.value).toLocaleDateString('it-IT') : f.value)}</dd>`).join('')}
          <dt>File</dt><dd>${esc(scheda.fileName || '')}</dd>
          <dt>Caricata il</dt><dd>${scheda.importedAt ? fmtDate(scheda.importedAt) : ''}</dd>
        </dl>
        ${m.texts.map((t) => `<p class="small muted" style="white-space:pre-line">${esc(t)}</p>`).join('')}
      </div>
      <button class="btn btn-primary btn-block" data-act="import">📄 Carica scheda aggiornata o nuova</button>
      <p class="small muted">Se il trainer aggiorna la scheda, scarica di nuovo il file da Drive e caricalo qui: progressi e storico restano.</p>

      <div class="section-title">Backup</div>
      <div class="row">
        <button class="btn" data-act="backup">⬇︎ Esporta dati</button>
        <button class="btn" data-act="restore">⬆︎ Ripristina</button>
      </div>
      <p class="small muted">I dati restano solo su questo telefono. Ogni tanto esporta un backup (foto e video esclusi).</p>

      <div class="section-title">Zona pericolosa</div>
      <button class="btn btn-block btn-danger" data-act="reset">Cancella tutti i dati</button>`;
  }

  /* ================= azioni ================= */
  function startDay(i) {
    const p = prog();
    if (session && session.scheda === scheda.title) {
      if (session.day === i) return go('workout');
      if (!confirm(`C'è un allenamento in corso (${scheda.days[session.day].title}). Lo abbandoni e inizi ${scheda.days[i].title}?`)) return;
    }
    session = { scheda: scheda.title, day: i, week: p.week, started: Date.now(), ex: {}, open: null };
    saveSession();
    go('workout');
  }

  function finishDay() {
    const day = scheda.days[session.day];
    const missing = day.exercises.filter((e) => !exState(e).done).length;
    if (missing && !confirm(`${missing} esercizi non sono segnati come fatti. Concludere comunque?`)) return;
    history.push({
      date: new Date().toISOString(),
      scheda: scheda.title,
      week: session.week,
      day: session.day,
      dayTitle: day.title,
      exercises: day.exercises
        .filter((e) => exState(e).done || exState(e).sets.some((s) => s.done))
        .map((e) => ({
          name: e.name,
          group: e.group,
          scheme: schemeFor(e, session.week),
          sets: exState(e).sets.filter((s) => s.done).map((s) => ({ kg: s.kg, reps: s.reps })),
        })),
    });
    store.set('history', history);

    const p = prog();
    const w = session.week;
    p.done[w] = [...new Set([...(p.done[w] || []), session.day])];
    let msg = `${day.title} completato! 💪`;
    if (p.week === w && scheda.days.every((_, i) => p.done[w].includes(i)) && w < scheda.weeks) {
      p.week = w + 1;
      msg = `Settimana ${w} completata! Si passa alla settimana ${w + 1}`;
    }
    saveProg();
    session = null;
    store.del('session');
    stopTimer();
    view = { name: 'home' };
    render();
    window.scrollTo(0, 0);
    toast(msg);
  }

  function toggleSet(id, i) {
    const day = scheda.days[session.day];
    const ex = day.exercises.find((e) => e.id === id);
    const st = exState(ex);
    const s = st.sets[i];
    const sch = P.parseScheme(schemeFor(ex, session.week));
    const isLast = i === st.sets.length - 1;
    if (!s.done) {
      if (!s.reps) {
        if (sch.plus && isLast) {
          const inp = app.querySelector(`input[data-f="reps"][data-id="${id}"][data-i="${i}"]`);
          if (inp) inp.focus();
          toast('Scrivi quante ripetizioni hai fatto');
          return;
        }
        s.reps = sch.reps.split(/[\/\-–]/)[0] || '';
      }
      s.done = true;
      ensureAudio();
      const allDone = st.sets.every((x) => x.done);
      if (allDone) {
        st.done = true;
        const next = day.exercises.find((e) => !exState(e).done);
        session.open = next ? next.id : null;
      }
      if (ex.restSec) startTimer(ex.restSec, allDone ? 'Recupero · prossimo esercizio' : `Recupero · serie ${i + 2} di ${st.sets.length}`);
      saveSession();
      renderWorkout();
      if (allDone && session.open) scrollToEx(session.open);
    } else {
      s.done = false;
      st.done = false;
      saveSession();
      renderWorkout();
    }
  }

  function scrollToEx(id) {
    requestAnimationFrame(() => {
      const el = document.getElementById('ex-' + id);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  function toggleGroup(g) {
    const day = scheda.days[session.day];
    const exs = day.exercises.filter((e) => e.group === g);
    const allDone = exs.every((e) => exState(e).done);
    exs.forEach((e) => { exState(e).done = !allDone; });
    if (!allDone) {
      const next = day.exercises.find((e) => !exState(e).done);
      session.open = next ? next.id : null;
    }
    saveSession();
    renderWorkout();
    if (!allDone && session.open) scrollToEx(session.open);
  }

  /* ---------- import ---------- */
  async function importFile(file) {
    const HELP = '\n\nProva così: apri l\'app Drive, tocca ⋮ accanto alla scheda → "Scarica", poi qui scegli il file dalla cartella Download.';
    try {
      const buf = await file.arrayBuffer();
      if (!buf.byteLength) {
        alert('Il file selezionato è vuoto: probabilmente è un Foglio Google che il telefono non riesce a convertire.' + HELP);
        return;
      }
      let wb;
      try { wb = XLSX.read(buf, { type: 'array', cellNF: true }); } catch (e) {
        alert(`"${file.name}" non sembra un foglio di calcolo leggibile.` + HELP);
        return;
      }
      const list = P.parseWorkbook(wb, XLSX);
      if (!list.length) {
        alert(`Non riesco a leggere la scheda in "${file.name}": non trovo righe tipo "GIORNO 1" con le colonne "SETTIMANA 1, 2...".` + HELP);
        return;
      }
      list.forEach((s) => { s.fileName = file.name; s.importedAt = new Date().toISOString(); });
      if (list.length > 1) {
        pendingSchede = list;
        render();
      } else {
        applyScheda(list[0]);
      }
    } catch (e) {
      console.error(e);
      alert('Errore nella lettura del file: ' + e.message);
    }
  }

  function applyScheda(s) {
    const same = scheda && scheda.title === s.title;
    scheda = s;
    pendingSchede = null;
    store.set('scheda', scheda);
    if (!allProgress[s.title]) {
      // prima volta: deduce la settimana dalla data di inizio della scheda
      const start = s.meta.fields.find((f) => /DATA|INIZIO/i.test(f.label) && /^\d{4}-\d{2}-\d{2}$/.test(f.value));
      const days = start ? Math.floor((Date.now() - new Date(start.value + 'T00:00:00')) / 86400000) : -1;
      allProgress[s.title] = { week: days >= 0 ? Math.min(s.weeks, Math.floor(days / 7) + 1) : 1, done: {} };
      saveProg();
    }
    if (session && session.scheda !== scheda.title) {
      session = null;
      store.del('session');
    }
    view = { name: 'home' };
    render();
    toast(same ? 'Scheda aggiornata ✓' : `Scheda caricata: ${s.days.length} giorni, ${s.weeks} settimane`);
  }

  function exportBackup() {
    const data = { app: 'scheda-palestra', version: 1, exportedAt: new Date().toISOString(), scheda, history, progress: allProgress, links, session };
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `backup-scheda-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function restoreBackup(file) {
    try {
      const data = JSON.parse(await file.text());
      if (data.app !== 'scheda-palestra') throw new Error('non è un backup di questa app');
      if (!confirm('Sostituire i dati attuali con quelli del backup?')) return;
      scheda = data.scheda || null;
      history = data.history || [];
      allProgress = data.progress || {};
      links = data.links || {};
      session = data.session || null;
      store.set('scheda', scheda);
      store.set('history', history);
      store.set('progress', allProgress);
      store.set('links', links);
      store.set('session', session);
      view = { name: 'home' };
      render();
      toast('Backup ripristinato ✓');
    } catch (e) {
      alert('Backup non valido: ' + e.message);
    }
  }

  /* ================= eventi ================= */
  const fileScheda = document.getElementById('file-scheda');
  const fileBackup = document.getElementById('file-backup');
  const fileMedia = document.getElementById('file-media');
  let mediaKey = null;

  fileScheda.addEventListener('change', () => { if (fileScheda.files[0]) importFile(fileScheda.files[0]); fileScheda.value = ''; });
  fileBackup.addEventListener('change', () => { if (fileBackup.files[0]) restoreBackup(fileBackup.files[0]); fileBackup.value = ''; });
  fileMedia.addEventListener('change', async () => {
    const f = fileMedia.files[0];
    fileMedia.value = '';
    if (!f || !mediaKey) return;
    try {
      await mediaDB.put(mediaKey, { blob: f, savedAt: Date.now() });
      if (mediaUrls[mediaKey]) { URL.revokeObjectURL(mediaUrls[mediaKey]); delete mediaUrls[mediaKey]; }
      loadMediaInto();
      toast('Salvato ✓');
    } catch (e) {
      alert('Impossibile salvare il file: ' + e.message);
    }
  });

  app.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-act]');
    if (!el) return;
    const a = el.dataset.act;
    if (el.tagName === 'A' && el.getAttribute('href') === '#') ev.preventDefault();
    switch (a) {
      case 'import': fileScheda.click(); break;
      case 'restore': fileBackup.click(); break;
      case 'backup': exportBackup(); break;
      case 'choose': applyScheda(pendingSchede[+el.dataset.i]); break;
      case 'choose-cancel': pendingSchede = null; render(); break;
      case 'go': go(el.dataset.view, el.dataset.i != null ? { i: +el.dataset.i } : {}); break;
      case 'home': case 'back':
        if (window.history.state && window.history.state.v) window.history.back();
        else { view = { name: 'home' }; render(); }
        break;
      case 'week': {
        const p = prog();
        p.week = Math.min(scheda.weeks, Math.max(1, p.week + +el.dataset.d));
        saveProg();
        render();
        break;
      }
      case 'start': startDay(+el.dataset.day); break;
      case 'resume': go('workout'); break;
      case 'abort':
        if (confirm('Annullare l\'allenamento in corso? Le serie segnate andranno perse.')) {
          session = null; store.del('session'); stopTimer(); render();
        }
        break;
      case 'toggle':
        session.open = session.open === el.dataset.id ? null : el.dataset.id;
        saveSession();
        renderWorkout();
        if (session.open) scrollToEx(session.open);
        break;
      case 'set': toggleSet(el.dataset.id, +el.dataset.i); break;
      case 'group': toggleGroup(el.dataset.g); break;
      case 'exdone': {
        const ex = scheda.days[session.day].exercises.find((e) => e.id === el.dataset.id);
        const st = exState(ex);
        st.done = !st.done;
        if (st.done) {
          const next = scheda.days[session.day].exercises.find((e) => !exState(e).done);
          session.open = next ? next.id : null;
        }
        saveSession();
        renderWorkout();
        if (st.done && session.open) scrollToEx(session.open);
        break;
      }
      case 'rest': ensureAudio(); startTimer(+el.dataset.s, 'Recupero'); break;
      case 'finish': finishDay(); break;
      case 'extra-timer': {
        const it = scheda.extras[view.i].items[+el.dataset.i];
        ensureAudio();
        startTimer(it.durationSec, it.name);
        break;
      }
      case 'link': {
        const k = el.dataset.k;
        const v = prompt('Incolla il link del video (YouTube, Instagram...). Lascia vuoto per rimuoverlo.', links[k] || '');
        if (v == null) break;
        const url = v.trim();
        if (url && !/^https?:\/\//i.test(url)) { alert('Il link deve iniziare con http:// o https://'); break; }
        if (url) links[k] = url; else delete links[k];
        store.set('links', links);
        render();
        break;
      }
      case 'media': mediaKey = el.dataset.k; fileMedia.click(); break;
      case 'media-del':
        if (confirm('Rimuovere la foto/video di questo esercizio?')) {
          const k = el.dataset.k;
          mediaDB.del(k).then(() => {
            if (mediaUrls[k]) { URL.revokeObjectURL(mediaUrls[k]); delete mediaUrls[k]; }
            loadMediaInto();
          });
        }
        break;
      case 'reset':
        if (confirm('Cancellare scheda, progressi e storico da questo telefono?') && confirm('Sicuro? Non si può annullare.')) {
          Object.keys(localStorage).filter((k) => k.startsWith('gp.')).forEach((k) => localStorage.removeItem(k));
          try { indexedDB.deleteDatabase('scheda-media'); } catch (e) { /* ignora */ }
          location.reload();
        }
        break;
    }
  });

  // input kg / ripetizioni: salva senza ridisegnare (per non perdere il focus)
  app.addEventListener('input', (ev) => {
    const inp = ev.target;
    if (!inp.dataset || !inp.dataset.f || !session) return;
    const ex = scheda.days[session.day].exercises.find((e) => e.id === inp.dataset.id);
    if (!ex) return;
    const st = exState(ex);
    const i = +inp.dataset.i;
    const raw = inp.value.replace(',', '.').trim();
    if (inp.dataset.f === 'kg') {
      const old = st.sets[i].kg;
      st.sets[i].kg = raw;
      // propaga il nuovo peso alle serie successive non ancora fatte
      for (let j = i + 1; j < st.sets.length; j++) {
        const s = st.sets[j];
        if (!s.done && String(s.kg) === String(old)) {
          s.kg = raw;
          const other = app.querySelector(`input[data-f="kg"][data-id="${ex.id}"][data-i="${j}"]`);
          if (other) other.value = fmtNum(raw);
        }
      }
    } else {
      st.sets[i].reps = raw;
    }
    saveSession();
  });

  /* ================= timer di recupero ================= */
  const tEl = document.getElementById('timer');
  const tTime = tEl.querySelector('.timer-time');
  const tLabel = tEl.querySelector('.timer-label');
  const tBar = tEl.querySelector('.timer-bar span');
  const timer = { end: 0, total: 0, iv: null, fired: false, lastBeep: null, hideT: null };
  let audio = null;

  function ensureAudio() {
    try {
      if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === 'suspended') audio.resume();
    } catch (e) { audio = null; }
  }
  function beep(freq, dur, when) {
    if (!audio) return;
    const t = audio.currentTime + (when || 0);
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.frequency.value = freq;
    o.type = 'sine';
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(audio.destination);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  function startTimer(sec, label) {
    if (!sec) return;
    clearTimeout(timer.hideT);
    timer.total = sec;
    timer.end = Date.now() + sec * 1000;
    timer.fired = false;
    timer.lastBeep = null;
    tLabel.textContent = label || 'Recupero';
    tEl.classList.remove('ended');
    tEl.hidden = false;
    clearInterval(timer.iv);
    timer.iv = setInterval(tick, 200);
    tick();
  }
  function stopTimer() {
    clearInterval(timer.iv);
    clearTimeout(timer.hideT);
    tEl.hidden = true;
  }
  function tick() {
    const ms = timer.end - Date.now();
    const left = Math.max(0, Math.ceil(ms / 1000));
    tTime.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    tBar.style.width = `${Math.min(100, Math.max(0, 100 - (ms / (timer.total * 1000)) * 100))}%`;
    if (left > 0 && left <= 3 && timer.lastBeep !== left) {
      timer.lastBeep = left;
      beep(660, 0.12);
    }
    if (ms <= 0 && !timer.fired) {
      timer.fired = true;
      clearInterval(timer.iv);
      tTime.textContent = 'Via! 💪';
      tEl.classList.add('ended');
      beep(990, 0.25); beep(990, 0.25, 0.3); beep(1320, 0.5, 0.6);
      if (navigator.vibrate) navigator.vibrate([400, 150, 400, 150, 700]);
      timer.hideT = setTimeout(stopTimer, 6000);
    }
  }
  tEl.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-t]');
    if (!b) return;
    if (b.dataset.t === 'stop') return stopTimer();
    const d = +b.dataset.t * 1000;
    if (timer.fired) { startTimer(Math.max(5, +b.dataset.t), tLabel.textContent); return; }
    timer.end += d;
    timer.total = Math.max(1, timer.total + d / 1000);
    if (timer.end <= Date.now()) timer.end = Date.now() + 1000;
    tick();
  });

  /* ================= schermo sempre acceso durante l'allenamento ================= */
  let wakeLock = null;
  async function updateWakeLock() {
    const want = view.name === 'workout' || view.name === 'extra';
    try {
      if (want && !wakeLock && 'wakeLock' in navigator && document.visibilityState === 'visible') {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } else if (!want && wakeLock) {
        await wakeLock.release();
        wakeLock = null;
      }
    } catch (e) { wakeLock = null; }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      updateWakeLock();
      if (!tEl.hidden && !timer.fired) tick();
    }
  });

  /* ================= toast ================= */
  const toastEl = document.getElementById('toast');
  let toastT = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastT);
    toastT = setTimeout(() => { toastEl.hidden = true; }, 3200);
  }

  /* ================= avvio ================= */
  if ('serviceWorker' in navigator && !/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  // in sviluppo: ?demo=file.xlsx carica direttamente un file servito localmente
  const demo = new URLSearchParams(location.search).get('demo');
  if (demo && /^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
    fetch(demo).then((r) => r.blob()).then((b) => importFile(new File([b], demo.split('/').pop())));
  }
  render();
})();
