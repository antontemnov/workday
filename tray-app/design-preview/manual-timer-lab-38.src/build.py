# Assembles ../manual-timer-lab-38.html from lab.css / lab.js / body.html.
# A standalone page: the tray icon is drawn in real pixels, the app snapshot is not needed.
# Usage: python build.py
import os
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'manual-timer-lab-38.html')
read = lambda n: open(os.path.join(HERE, n), encoding='utf-8').read()
html = ('<!doctype html>\n<html lang="ru">\n<head>\n<meta charset="utf-8">\n'
        '<title>Иконка в трее при таймере — мини-макеты v38</title>\n'
        '<style>\n' + read('lab.css') + '\n</style>\n</head>\n<body class="lab">\n'
        + read('body.html')
        + '\n<script>\n' + read('lab.js') + '\n</script>\n</body>\n</html>\n')
open(OUT, 'w', encoding='utf-8').write(html)
print('written', os.path.normpath(OUT), len(html))
