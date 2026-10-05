(function () {
  'use strict';

  const APP_VERSION = '15';
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
    document.body.classList.toggle('has-nav', view.name === 'workout' && !!session);
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
          <div class="day-item day-row">
            <button class="day-check" data-act="daydone" data-day="${i}" aria-label="${doneW.includes(i) ? 'Togli spunta' : 'Segna come fatto'} ${esc(d.title)}">
              <span class="check ${doneW.includes(i) ? 'on' : ''}">✓</span>
            </button>
            <button class="day-main" data-act="start" data-day="${i}">
              <div class="grow">
                <div class="title">${esc(d.title)}</div>
                <div class="muted small">${groupsOf(d).map(esc).join(' · ')}</div>
              </div>
              <span class="muted">›</span>
            </button>
          </div>`).join('')}
      </div>

      <div class="section-title">Altro</div>
      <div class="row">
        <button class="btn" data-act="go" data-view="history">📈 Storico</button>
        <button class="btn" data-act="import">📄 Carica scheda</button>
      </div>`;
  }

  /* ---------- allenamento: un esercizio alla volta ---------- */
  function exState(ex) {
    if (!session.ex[ex.id]) session.ex[ex.id] = { done: false };
    return session.ex[ex.id];
  }

  /* serie spuntate dell'esercizio: array di true/false lungo quanto le serie della settimana */
  function setsOf(ex) {
    const st = exState(ex);
    const n = Math.max(1, P.parseScheme(schemeFor(ex, session.week)).sets || 1);
    let sets = Array.isArray(st.sets) ? st.sets.map((x) => (x && typeof x === 'object' ? !!x.done : !!x)) : [];
    if (st.done && !sets.some(Boolean)) sets = [];
    sets = Array.from({ length: n }, (_, j) => (st.done && !sets.length) || !!sets[j]);
    st.sets = sets;
    return sets;
  }

  /* spunta (on=true) o toglie una serie; se sono tutte fatte l'esercizio è finito e si passa al successivo */
  function setSerie(id, j, on) {
    const exs = scheda.days[session.day].exercises;
    const i = exs.findIndex((e) => e.id === id);
    const ex = exs[i];
    const st = exState(ex);
    const sets = setsOf(ex);
    sets[j] = on;
    const all = sets.every(Boolean);
    st.done = all;
    saveSession();
    renderWorkout();
    if (all) celebrate(i, id);
  }

  /* messaggio "Ben fatto!" per un paio di secondi, poi esercizio successivo (toccando si salta l'attesa) */
  const cheerEl = document.getElementById('cheer');
  let cheerT = null;
  let cheerGo = null;
  function celebrate(i, id) {
    const exs = scheda.days[session.day].exercises;
    const next = exs.slice(i + 1).concat(exs.slice(0, i)).find((e) => !exState(e).done);
    cheerEl.querySelector('.cheer-sub').textContent = next
      ? `Passiamo all'esercizio successivo: ${next.name}`
      : 'Hai completato tutti gli esercizi del giorno!';
    cheerEl.hidden = false;
    clearTimeout(cheerT);
    cheerGo = () => {
      cheerEl.hidden = true;
      cheerGo = null;
      if (view.name === 'workout' && session && session.open === id && next) showExercise(exs.indexOf(next));
    };
    cheerT = setTimeout(() => cheerGo && cheerGo(), 2200);
  }
  cheerEl.addEventListener('click', () => { clearTimeout(cheerT); if (cheerGo) cheerGo(); });

  function currentIndex(day) {
    let i = day.exercises.findIndex((e) => e.id === session.open);
    if (i < 0) {
      i = day.exercises.findIndex((e) => !exState(e).done);
      if (i < 0) i = day.exercises.length - 1;
      session.open = day.exercises[i].id;
    }
    return i;
  }

  function renderWorkout() {
    const day = scheda.days[session.day];
    const w = session.week;
    const idx = currentIndex(day);
    const ex = day.exercises[idx];
    const st = exState(ex);
    const total = day.exercises.length;
    const nDone = day.exercises.filter((e) => exState(e).done).length;
    const raw = schemeFor(ex, w);
    const sch = P.parseScheme(raw);
    const ref = kgFor(ex, w);
    const schemeHtml = sch.sets
      ? `${sch.sets} × ${esc(sch.reps)}${sch.plus ? '<span class="plus">+</span>' : ''}`
      : esc(raw);
    const isLast = idx === total - 1;

    app.innerHTML = `
      <header class="top">
        <button class="icon-btn" data-act="home" aria-label="Indietro">‹</button>
        <div style="flex:1;min-width:0">
          <div class="eyebrow">Settimana ${w}${weekLabel(w, day) ? ' · ' + esc(weekLabel(w, day)) : ''}</div>
          <h1>${esc(day.title)} <span class="muted" style="font-weight:500;font-size:1rem">${nDone}/${total} fatti</span></h1>
        </div>
      </header>
      <div class="progress">
        ${day.exercises.map((e, i) => `<button class="seg ${exState(e).done ? 'on' : ''} ${i === idx ? 'cur' : ''}" data-act="jump" data-i="${i}" aria-label="${esc(e.name)}"></button>`).join('')}
      </div>

      <article class="ex-one ${st.done ? 'done' : ''}">
        <div class="eyebrow">${esc(ex.group)} · ${idx + 1} di ${total}</div>
        <h2 class="ex-name">${esc(ex.name)}</h2>
        <div class="ex-scheme">${schemeHtml}</div>
        ${ref ? `<div class="ex-kg">${esc(ref.text)}</div>` : ''}
        ${sch.extra && sch.sets ? `<div class="ex-extra">${esc(sch.extra)}</div>` : ''}
        <div class="sets-check" role="group" aria-label="Serie fatte">
          ${setsOf(ex).map((on, j) => `<button class="setc ${on ? 'on' : ''}" data-act="setc" data-id="${ex.id}" data-j="${j}" aria-pressed="${on}" aria-label="Serie ${j + 1}">${on ? '✓' : j + 1}${sch.plus && j === setsOf(ex).length - 1 && !on ? '+' : ''}</button>`).join('')}
        </div>
        ${ex.note ? `<div class="note">💡 ${esc(ex.note)}</div>` : ''}
        ${sch.plus ? `
          <label class="amrap">
            <span>➕ Ultima serie: più ripetizioni che puoi.<br><b>Quante ne hai fatte?</b></span>
            <input type="number" inputmode="numeric" min="0" data-amrap="${ex.id}" value="${esc(st.reps || '')}" placeholder="${esc(sch.reps.split(/[\/\-–]/)[0])}" aria-label="Ripetizioni ultima serie">
          </label>` : ''}
        <div class="big-actions">
          ${ex.restSec ? `<button class="btn big" data-act="rest" data-id="${ex.id}" data-s="${ex.restSec}">⏱ Recupero<small>${ex.restSec} sec</small></button>` : ''}
          <button class="btn big ${st.done ? 'is-done' : 'btn-primary'}" data-act="exdone" data-id="${ex.id}">${st.done ? '✓ Fatto<small>tocca per annullare</small>' : '✓ Esercizio fatto'}</button>
        </div>
        ${isLast || nDone === total ? `
          <div class="day-end">
            ${scheda.extras.length ? `<div class="row">${scheda.extras.map((x, i) =>
              `<button class="btn" data-act="go" data-view="extra" data-i="${i}">🔥 ${esc(x.title)}</button>`).join('')}</div>` : ''}
            <button class="btn btn-block" data-act="finish">🏁 Concludi ${esc(day.title)}</button>
          </div>` : ''}
      </article>

      ${renderHow(ex.name)}

      <nav class="ex-nav">
        <button class="nav-btn" data-act="prev" ${idx === 0 ? 'disabled' : ''} aria-label="Esercizio precedente">←</button>
        <div class="nav-mid">${idx + 1} / ${total}</div>
        <button class="nav-btn" data-act="next" ${isLast ? 'disabled' : ''} aria-label="Esercizio successivo">→</button>
      </nav>`;

    loadMediaInto();
  }

  function showExercise(i) {
    const day = scheda.days[session.day];
    if (i < 0 || i >= day.exercises.length) return;
    session.open = day.exercises[i].id;
    saveSession();
    renderWorkout();
    window.scrollTo(0, 0);
  }

  /* ---------- "come si fa": video e foto ---------- */
  function renderHow(name) {
    const k = keyOf(name);
    const yt = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(name.toLowerCase() + ' esecuzione corretta');
    return `
      <div class="how">
        <h3>Come si fa</h3>
        <div class="media" data-media="${esc(k)}"></div>
        <div class="row">
          <a class="btn btn-small" href="${esc(yt)}" target="_blank" rel="noopener">▶ YouTube</a>
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
      </div>`;
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
                <div>${e.sets.length ? e.sets.map((s) => `${fmtNum(s.kg) || '–'}kg × ${s.reps || '–'}`).join(' · ') : `<span class="muted">✓ ${esc(e.kg || 'fatto')}</span>${e.reps ? ` · <b>ultima serie: ${esc(e.reps)} rip.</b>` : ''}`}</div>
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

      <p class="small muted" style="text-align:center;margin-top:28px">Versione app: ${APP_VERSION}</p>

      <div class="section-title">Zona pericolosa</div>
      <button class="btn btn-block btn-danger" data-act="reset">Cancella tutti i dati</button>`;
  }

  /* ================= finestra di conferma (al posto di confirm/alert del browser) ================= */
  const dlg = document.getElementById('dialog');
  function ask(msg, opts) {
    const o = Object.assign({ ok: 'OK', cancel: 'Annulla', danger: false }, opts);
    dlg.querySelector('.dialog-msg').textContent = msg;
    const okBtn = dlg.querySelector('[data-d="ok"]');
    const cancelBtn = dlg.querySelector('[data-d="cancel"]');
    okBtn.textContent = o.ok;
    okBtn.className = 'btn ' + (o.danger ? 'btn-danger-fill' : 'btn-primary');
    cancelBtn.textContent = o.cancel || '';
    cancelBtn.hidden = o.cancel == null;
    dlg.hidden = false;
    return new Promise((resolve) => {
      dlg.onclick = (ev) => {
        const b = ev.target.closest('[data-d]');
        if (!b && ev.target !== dlg) return; // tocco dentro il riquadro ma non sui pulsanti
        dlg.hidden = true;
        dlg.onclick = null;
        resolve(!!b && b.dataset.d === 'ok');
      };
    });
  }
  const info = (msg) => ask(msg, { cancel: null });

  /* ================= azioni ================= */
  async function startDay(i) {
    const p = prog();
    if (session && session.scheda === scheda.title) {
      if (session.day === i) return go('workout');
      if (!(await ask(`C'è un allenamento in corso (${scheda.days[session.day].title}).\nLo abbandoni e inizi ${scheda.days[i].title}?`, { ok: 'Sì, inizia', danger: true }))) return;
    }
    session = { scheda: scheda.title, day: i, week: p.week, started: Date.now(), ex: {}, open: null };
    saveSession();
    go('workout');
  }

  async function finishDay() {
    const day = scheda.days[session.day];
    const missing = day.exercises.filter((e) => !exState(e).done).length;
    if (missing && !(await ask(`${missing === 1 ? '1 esercizio non è segnato come fatto' : missing + ' esercizi non sono segnati come fatti'}.\nConcludere comunque?`, { ok: 'Concludi' }))) return;
    history.push({
      date: new Date().toISOString(),
      scheda: scheda.title,
      week: session.week,
      day: session.day,
      dayTitle: day.title,
      exercises: day.exercises
        .filter((e) => exState(e).done)
        .map((e) => {
          const ref = kgFor(e, session.week);
          return { name: e.name, group: e.group, scheme: schemeFor(e, session.week), kg: ref ? ref.text : '', reps: exState(e).reps || '', sets: [] };
        }),
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

  /* ---------- import ---------- */
  async function importFile(file) {
    const HELP = '\n\nProva così: apri l\'app Drive, tocca ⋮ accanto alla scheda → "Scarica", poi qui scegli il file dalla cartella Download.';
    try {
      const buf = await file.arrayBuffer();
      if (!buf.byteLength) {
        await info('Il file selezionato è vuoto: probabilmente è un Foglio Google che il telefono non riesce a convertire.' + HELP);
        return;
      }
      let wb;
      try { wb = XLSX.read(buf, { type: 'array', cellNF: true }); } catch (e) {
        await info(`"${file.name}" non sembra un foglio di calcolo leggibile.` + HELP);
        return;
      }
      const list = P.parseWorkbook(wb, XLSX);
      if (!list.length) {
        await info(`Non riesco a leggere la scheda in "${file.name}": non trovo righe tipo "GIORNO 1" con le colonne "SETTIMANA 1, 2...".` + HELP);
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
      await info('Errore nella lettura del file: ' + e.message);
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
      if (!(await ask('Sostituire i dati attuali con quelli del backup?', { ok: 'Sostituisci', danger: true }))) return;
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
      await info('Backup non valido: ' + e.message);
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
      await info('Impossibile salvare il file: ' + e.message);
    }
  });

  // ripetizioni fatte nella serie "+": salva mentre scrivi, senza ridisegnare
  app.addEventListener('input', (ev) => {
    const id = ev.target.dataset && ev.target.dataset.amrap;
    if (!id || !session) return;
    session.ex[id] = Object.assign(session.ex[id] || { done: false }, { reps: ev.target.value.trim() });
    saveSession();
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
        ask('Annullare l\'allenamento in corso?\nLe serie segnate andranno perse.', { ok: 'Annulla allenamento', cancel: 'Continua', danger: true }).then((ok) => {
          if (ok) { session = null; store.del('session'); stopTimer(); render(); }
        });
        break;
      case 'daydone': {
        const i = +el.dataset.day;
        const p = prog();
        const done = p.done[p.week] || [];
        const on = done.includes(i);
        ask(on ? `Togliere la spunta da ${scheda.days[i].title} (settimana ${p.week})?` : `Segnare ${scheda.days[i].title} come fatto nella settimana ${p.week}?`,
          { ok: on ? 'Togli spunta' : 'Segna fatto' }).then((ok) => {
          if (!ok) return;
          p.done[p.week] = on ? done.filter((d) => d !== i) : [...done, i];
          saveProg();
          render();
        });
        break;
      }
      case 'prev': case 'next': {
        const day = scheda.days[session.day];
        showExercise(currentIndex(day) + (a === 'next' ? 1 : -1));
        break;
      }
      case 'jump': showExercise(+el.dataset.i); break;
      case 'exdone': {
        const exs = scheda.days[session.day].exercises;
        const i = exs.findIndex((e) => e.id === el.dataset.id);
        const st = exState(exs[i]);
        st.done = !st.done;
        st.sets = setsOf(exs[i]).map(() => st.done);
        saveSession();
        renderWorkout();
        if (st.done) celebrate(i, exs[i].id);
        break;
      }
      case 'rest': {
        ensureAudio();
        const ex = scheda.days[session.day].exercises.find((e) => e.id === el.dataset.id);
        const sets = setsOf(ex);
        const j = sets.indexOf(false);
        if (j < 0) { startTimer(+el.dataset.s, 'Recupero'); break; }
        startTimer(+el.dataset.s, 'Recupero');
        setSerie(ex.id, j, true);
        break;
      }
      case 'setc': setSerie(el.dataset.id, +el.dataset.j, !setsOf(scheda.days[session.day].exercises.find((e) => e.id === el.dataset.id))[+el.dataset.j]); break;
      case 'finish': finishDay(); break;
      case 'extra-timer': {
        const it = scheda.extras[view.i].items[+el.dataset.i];
        ensureAudio();
        startTimer(it.durationSec, it.name, 'cardio');
        break;
      }
      case 'media': mediaKey = el.dataset.k; fileMedia.click(); break;
      case 'media-del':
        ask('Rimuovere la foto/video di questo esercizio?', { ok: 'Rimuovi', danger: true }).then((ok) => {
          if (!ok) return;
          const k = el.dataset.k;
          mediaDB.del(k).then(() => {
            if (mediaUrls[k]) { URL.revokeObjectURL(mediaUrls[k]); delete mediaUrls[k]; }
            loadMediaInto();
          });
        });
        break;
      case 'reset':
        (async () => {
          if (!(await ask('Cancellare scheda, progressi e storico da questo telefono?', { ok: 'Cancella', danger: true }))) return;
          if (!(await ask('Sicuro? Non si può annullare.', { ok: 'Sì, cancella tutto', danger: true }))) return;
          Object.keys(localStorage).filter((k) => k.startsWith('gp.')).forEach((k) => localStorage.removeItem(k));
          try { indexedDB.deleteDatabase('scheda-media'); } catch (e) { /* ignora */ }
          location.reload();
        })();
        break;
    }
  });

  // scorrimento orizzontale col dito per cambiare esercizio
  let touch = null;
  app.addEventListener('touchstart', (ev) => {
    if (view.name !== 'workout' || ev.touches.length !== 1) return;
    touch = { x: ev.touches[0].clientX, y: ev.touches[0].clientY };
  }, { passive: true });
  app.addEventListener('touchend', (ev) => {
    if (!touch || view.name !== 'workout' || !session) return;
    const dx = ev.changedTouches[0].clientX - touch.x;
    const dy = ev.changedTouches[0].clientY - touch.y;
    touch = null;
    if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    showExercise(currentIndex(scheda.days[session.day]) + (dx < 0 ? 1 : -1));
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
  function beep(freq, dur, when, loud) {
    if (!audio) return;
    const t = audio.currentTime + (when || 0);
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.frequency.value = freq;
    o.type = loud ? 'square' : 'sine'; // l'onda quadra si sente molto di più
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(1, t + 0.01);
    g.gain.setValueAtTime(1, t + dur - 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(audioOut());
    o.start(t);
    o.stop(t + dur + 0.05);
  }
  // compressore: alza il volume percepito senza distorcere
  let out = null;
  function audioOut() {
    if (!out) {
      out = audio.createDynamicsCompressor();
      out.threshold.value = -30;
      out.knee.value = 0;
      out.ratio.value = 12;
      const gain = audio.createGain();
      gain.gain.value = 2.5;
      out.connect(gain).connect(audio.destination);
    }
    return out;
  }
  function alarm() {
    // 3 raffiche di bip acuti (circa 2 secondi)
    for (let r = 0; r < 3; r++) {
      const base = r * 0.7;
      beep(2093, 0.14, base, true);
      beep(2637, 0.14, base + 0.18, true);
      beep(2093, 0.14, base + 0.36, true);
    }
  }

  // mode 'cardio': bip ogni 30 s, doppio bip a 15 s dalla fine, ultimi 5 secondi scanditi
  function startTimer(sec, label, mode) {
    if (!sec) return;
    timer.mode = mode || 'rest';
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
  function cue(left) {
    const vib = (p) => { if (navigator.vibrate) navigator.vibrate(p); };
    if (timer.mode !== 'cardio') {
      if (left <= 3) beep(1568, 0.12, 0, true);
      return;
    }
    const elapsed = timer.total - left;
    if (left <= 5) {
      beep(1568, 0.1, 0, true); // conto alla rovescia: 5, 4, 3, 2, 1
      vib(60);
    } else if (left === 15) {
      beep(1319, 0.14, 0, true); // doppio bip: mancano 15 secondi
      beep(1319, 0.14, 0.22, true);
      vib([120, 100, 120]);
    } else if (elapsed > 0 && elapsed % 30 === 0) {
      beep(1047, 0.3, 0, true); // bip lungo ogni 30 secondi
      vib(200);
    }
  }
  function tick() {
    const ms = timer.end - Date.now();
    const left = Math.max(0, Math.ceil(ms / 1000));
    tTime.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    tBar.style.width = `${Math.min(100, Math.max(0, 100 - (ms / (timer.total * 1000)) * 100))}%`;
    if (left > 0 && timer.lastBeep !== left) {
      timer.lastBeep = left;
      cue(left);
    }
    if (ms <= 0 && !timer.fired) {
      timer.fired = true;
      clearInterval(timer.iv);
      tTime.textContent = 'Via! 💪';
      tEl.classList.add('ended');
      alarm();
      if (navigator.vibrate) navigator.vibrate([500, 150, 500, 150, 900]);
      timer.hideT = setTimeout(stopTimer, 6000);
    }
  }
  tEl.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-t]');
    if (!b) return;
    if (b.dataset.t === 'stop') return stopTimer();
    const d = +b.dataset.t * 1000;
    if (timer.fired) { startTimer(Math.max(5, +b.dataset.t), tLabel.textContent, timer.mode); return; }
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
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
      // controlla se c'è una versione nuova ogni volta che l'app torna in primo piano
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    }).catch(() => {});
    // nuova versione installata: ricarica una volta (i dati dell'allenamento sono già salvati)
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloaded) return;
      reloaded = true;
      location.reload();
    });
  }
  // in sviluppo: ?demo=file.xlsx carica direttamente un file servito localmente
  const demo = new URLSearchParams(location.search).get('demo');
  if (demo && /^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
    fetch(demo).then((r) => r.blob()).then((b) => importFile(new File([b], demo.split('/').pop())));
  }
  render();
})();
