"""Scarica i disegni Everkinetic per gli esercizi della tabella esercizi/esercizi.json.

Uso:  python tools/build_esercizi.py
Per ogni voce con "rif" salva esercizi/img/<rif>-1.svg (posizione iniziale)
e esercizi/img/<rif>-2.svg (posizione finale). I file già presenti non vengono riscaricati.
"""
import json
import pathlib
import sys
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
TABLE = ROOT / 'esercizi' / 'esercizi.json'
IMG = ROOT / 'esercizi' / 'img'
BASE = 'https://raw.githubusercontent.com/everkinetic/data/master/'


def get(url):
    with urllib.request.urlopen(url, timeout=30) as r:
        return r.read()


def main():
    table = json.loads(TABLE.read_text(encoding='utf-8'))
    catalog = {x['name']: x for x in json.loads(get(BASE + 'exercises.json'))}
    IMG.mkdir(parents=True, exist_ok=True)
    errors = 0
    for e in table['esercizi']:
        rif = e.get('rif')
        if not rif:
            continue
        if rif not in catalog:
            print(f'!! {e["nome"]}: "{rif}" non esiste in Everkinetic')
            errors += 1
            continue
        num = catalog[rif]['id_num']
        for i, kind in ((1, 'relaxation'), (2, 'tension')):
            out = IMG / f'{rif}-{i}.svg'
            if out.exists():
                continue
            try:
                out.write_bytes(get(f'{BASE}dist/svg/{num}-{kind}.svg'))
                print('scaricato', out.name)
            except urllib.error.HTTPError:
                print(f'!! {e["nome"]}: "{rif}" non ha il disegno {i}')
                errors += 1
    sys.exit(1 if errors else 0)


if __name__ == '__main__':
    main()
