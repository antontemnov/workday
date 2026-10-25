# Assembles ../manual-timer-lab-12.html from the lab-11 snapshot
# (../manual-timer-lab-11.src/capture.json, see capture.mjs there)
# + lab.css / lab.js / body.html.
# Usage: python build.py
import json, re, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'manual-timer-lab-12.html')
cap = json.load(open(os.path.join(HERE, '..', 'manual-timer-lab-11.src', 'capture.json'), encoding='utf-8'))

styles, seen = [], set()
for k in ('day', 'set', 'sheet'):
    for s in cap[k]['styles']:
        s = re.sub(r'/\*# sourceMappingURL=.*?\*/', '', s)
        if s not in seen:
            seen.add(s); styles.append(s)

def clean(h):
    return re.sub(r'\s(?:ng-reflect-[\w-]+|ng-version)="[^"]*"', '', h)

app = clean(cap['day']['html'])
set_view = clean(cap['set']['view'])
sheet_view = clean(cap['sheet']['view'])
read = lambda n: open(os.path.join(HERE, n), encoding='utf-8').read()
body = read('body.html').replace('%%APP%%', app)
html = ('<!doctype html>\n<html lang="ru">\n<head>\n<meta charset="utf-8">\n'
        '<title>Ручной таймер — макет v12</title>\n'
        + ''.join('<style>\n' + s + '\n</style>\n' for s in styles)
        + '<style>\n' + read('lab.css') + '\n</style>\n</head>\n<body class="lab">\n'
        + body
        + '\n<template id="tpl-set">' + set_view + '</template>\n'
        + '<template id="tpl-sheet">' + sheet_view + '</template>\n'
        + '<script>\n' + read('lab.js') + '\n</script>\n</body>\n</html>\n')
open(OUT, 'w', encoding='utf-8').write(html)
print('written', os.path.normpath(OUT), len(html))
