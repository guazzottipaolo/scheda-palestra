# Scheda Palestra

App web (PWA) per leggere comodamente dal telefono la scheda di allenamento del personal trainer.

App: https://guazzottipaolo.github.io/scheda-palestra/

- La scheda (.xlsx) si carica dal telefono: non è mai salvata in questo repository.
- `esercizi/esercizi.json` è la tabella degli esercizi con il riferimento al disegno.
  Per aggiungere un esercizio: aggiungi una voce con `nome`, `alias` e `rif`, poi esegui
  `python tools/build_esercizi.py` per scaricare i disegni in `esercizi/img/`.

## Crediti

Disegni degli esercizi: [Everkinetic](https://github.com/everkinetic/data), licenza
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). I disegni in `esercizi/img/`
sono redistribuiti senza modifiche con la stessa licenza.
