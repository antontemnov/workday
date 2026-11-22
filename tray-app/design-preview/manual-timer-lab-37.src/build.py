# Assembles ../manual-timer-lab-37.html from lab.css / lab.js / body.html.
# A standalone page: the widget lives on the desktop, the app snapshot is not needed.
# Usage: python build.py
import os
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'manual-timer-lab-37.html')
read = lambda n: open(os.path.join(HERE, n), encoding='utf-8').read()
html = ('<!doctype html>\n<html lang="ru">\n<head>\n<meta charset="utf-8">\n'
        '<title>Виджет с несколькими таймерами — мини-макеты v37</title>\n'
        '<style>\n' + read('lab.css') + '\n</style>\n</head>\n<body class="lab">\n'
        + read('body.html')
        + '\n<script>\n' + read('lab.js') + '\n</script>\n</body>\n</html>\n')
open(OUT, 'w', encoding='utf-8').write(html)
print('written', os.path.normpath(OUT), len(html))
