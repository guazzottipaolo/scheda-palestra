# Scheda palestra

## Scopo
App web installabile sul telefono (PWA) per leggere in palestra la scheda di allenamento del personal trainer: giorni, esercizi, serie, recuperi e carichi, con timer di recupero e spunta dei giorni fatti. Online su https://guazzottipaolo.github.io/scheda-palestra/ (GitHub Pages, dal repository pubblico `guazzottipaolo/scheda-palestra`, ramo `main`).

## Struttura
- `index.html` + `styles.css`: la pagina. `app.js`: l'app (schermate, timer, salvataggi; numero di versione in `APP_VERSION`).
- `parser.js`: legge la scheda .xlsx senza dipendere da celle fisse (cerca "GIORNO N", le colonne "SETTIMANA N", "RECUPERO", "KG", "NOTE" e gli schemi tipo "4 x 8").
- `importers.js`: legge anche schede in PDF (con `vendor/pdf.min.js`) e Word .docx (zip letto dal browser, senza librerie).
- `vendor/`: librerie già scaricate (`xlsx.mini.min.js`, `pdf.min.js`, `pdf.worker.min.js`).
- `sw.js`: service worker; prima la rete, senza connessione usa la copia salvata (cache `scheda-vN`). `manifest.webmanifest` e `icons/`: installazione come app.
- `anim/`: video MP4 di prova di alcuni esercizi (anteprima RepDB, licenza CC BY-NC 4.0, uso non commerciale), versione uomo e donna.
- Dati dell'utente solo nel telefono: impostazioni e progressi in localStorage (chiavi `gp.*`), foto e video degli esercizi in IndexedDB (`scheda-media`).

## Regole da non rompere
- Il repository è pubblico: mai la scheda né documenti personali. `.xlsx`, `.xls`, `.csv`, `.pdf`, `backup-*.json` e `repdb-preview*` restano esclusi dal `.gitignore`; i file personali in cartella (scheda Excel, PDF della proposta) non vanno mai aggiunti.
- La scheda si carica dal telefono, non viene mai salvata nel repository.
- A ogni modifica dei file dell'app, aumentare insieme `APP_VERSION` in `app.js` e `CACHE` in `sw.js` (oggi 17 e `scheda-v17`), altrimenti i telefoni continuano a usare la copia vecchia. Un file nuovo dell'app va aggiunto anche ad `ASSETS` in `sw.js`.
- I video di `anim/` non si usano per scopi commerciali; i crediti restano nel README.
- Mai password, token o chiavi nei file o nel repository; nessun nome di persona nei file pubblici.

## Comandi utili
- Provarla in locale: `python -m http.server 8765` dalla cartella, poi http://localhost:8765 (come in `.claude\launch.json`).
- Pubblicare: commit e `git push origin main`; GitHub Pages si aggiorna da solo (tiene la cache circa 10 minuti).

## Convenzioni
- Rispondere sempre in italiano, spiegando i passaggi con calma.
- Chiedere conferma prima di pubblicare (push su `main` = app aggiornata per chi la usa).
