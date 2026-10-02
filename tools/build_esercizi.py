"""Scarica le foto Free Exercise DB per gli esercizi della tabella esercizi/esercizi.json.

Uso:  python tools/build_esercizi.py
Per ogni voce con "foto" salva esercizi/img/<foto>-1.jpg (posizione iniziale)
e esercizi/img/<foto>-2.jpg (posizione finale). I file già presenti non vengono riscaricati;
le immagini non più usate dalla tabella vengono cancellate.
"""
import json
import pathlib
import sys
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
TABLE = ROOT / 'esercizi' / 'esercizi.json'
IMG = ROOT / 'esercizi' / 'img'
BASE = 'https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/'


def get(url):
    with urllib.request.urlopen(url, timeout=30) as r:
        return r.read()


def shrink(path, size=480):
    """Riduce la foto (lato max 480 px) per caricarla in fretta sul telefono. Serve Pillow."""
    try:
        from PIL import Image
    except ImportError:
        return
    with Image.open(path) as im:
        im = im.convert('RGB')
        im.thumbnail((size, size))
        im.save(path, 'JPEG', quality=78, optimize=True, progressive=True)


def main():
    table = json.loads(TABLE.read_text(encoding='utf-8'))
    catalog = {x['id']: x for x in json.loads(get(BASE + 'dist/exercises.json'))}
    IMG.mkdir(parents=True, exist_ok=True)
    wanted = set()
    errors = 0
    for e in table['esercizi']:
        fid = e.get('foto')
        if not fid:
            continue
        if fid not in catalog or len(catalog[fid]['images']) < 2:
            print(f'!! {e["nome"]}: "{fid}" non esiste in Free Exercise DB o non ha 2 foto')
            errors += 1
            continue
        for i, src in enumerate(catalog[fid]['images'][:2], start=1):
            out = IMG / f'{fid}-{i}.jpg'
            wanted.add(out.name)
            if out.exists():
                continue
            try:
                out.write_bytes(get(BASE + 'exercises/' + src))
                shrink(out)
                print('scaricato', out.name)
            except urllib.error.HTTPError as err:
                print(f'!! {e["nome"]}: errore {err.code} scaricando {src}')
                errors += 1
    for f in IMG.iterdir():
        if f.name not in wanted:
            f.unlink()
            print('rimosso', f.name)
    sys.exit(1 if errors else 0)


if __name__ == '__main__':
    main()
