# Scheda Palestra

App web (PWA) per leggere comodamente dal telefono la scheda di allenamento del personal trainer.

App: https://guazzottipaolo.github.io/scheda-palestra/

- La scheda (.xlsx) si carica dal telefono: non è mai salvata in questo repository.
- `esercizi/esercizi.json` è la tabella degli esercizi con il riferimento alla foto.
  Per aggiungere un esercizio: aggiungi una voce con `nome`, `alias` e `foto` (id di Free Exercise DB),
  poi esegui `python tools/build_esercizi.py` per scaricare le foto in `esercizi/img/`.

## Crediti

Foto degli esercizi: [Free Exercise DB](https://github.com/yuhonas/free-exercise-db), pubblico dominio (Unlicense).
