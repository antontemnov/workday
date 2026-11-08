# Assembles ../manual-timer-lab-20.html from the lab-11 snapshot
# (../manual-timer-lab-11.src/capture.json, see capture.mjs there)
# + lab.css / lab.js / body.html.
# Usage: python build.py
import json, re, os
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'manual-timer-lab-20.html')
cap = json.load(open(os.path.join(HERE, '..', 'manual-timer-lab-11.src', 'capture.json'), encoding='utf-8'))

styles, seen = [], set()
for s in cap['day']['styles']:
    s = re.sub(r'/\*# sourceMappingURL=.*?\*/', '', s)
    if s not in seen:
        seen.add(s); styles.append(s)

app = re.sub(r'\s(?:ng-reflect-[\w-]+|ng-version)="[^"]*"', '', cap['day']['html'])
read = lambda n: open(os.path.join(HERE, n), encoding='utf-8').read()
html = ('<!doctype html>\n<html lang="ru">\n<head>\n<meta charset="utf-8">\n'
        '<title>Строка таймера — мини-макеты v20</title>\n'
        + ''.join('<style>\n' + s + '\n</style>\n' for s in styles)
        + '<style>\n' + read('lab.css') + '\n</style>\n</head>\n<body class="lab">\n'
        + read('body.html').replace('%%APP%%', app)
        + '\n<script>\n' + read('lab.js') + '\n</script>\n</body>\n</html>\n')
open(OUT, 'w', encoding='utf-8').write(html)
print('written', os.path.normpath(OUT), len(html))
