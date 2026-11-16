import pathlib
src = pathlib.Path(__file__).parent / 'src'
order = ['core.js','sources.js','state.js','charts.js','components.js','aura.js','aura-ai.js','aura-view.js','views.js','app.js']
js = '\n'.join((src/f).read_text() for f in order)
css = (src/'styles.css').read_text()
html = (src/'index.template.html').read_text().replace('/*__CSS__*/', css).replace('/*__JS__*/', js)
assert '</script' not in js.replace('</script>','')  # sanity
(pathlib.Path(__file__).parent/'index.html').write_text(html)
print('built', len(html)//1024, 'KB')
