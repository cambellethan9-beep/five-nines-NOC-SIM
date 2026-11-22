// Bundles the Vite build in dist/ into a single self-contained HTML file for the claude.ai share link
// (the artifact host only allows inline CSS/JS plus Google Fonts). Run `npm run build` first.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const assets = readdirSync('dist/assets');
const css = readFileSync(join('dist/assets', assets.find((f) => f.endsWith('.css'))), 'utf8');
const js = readFileSync(join('dist/assets', assets.find((f) => f.endsWith('.js'))), 'utf8');
if (js.includes('</script')) throw new Error('Bundle contains "</script", which would break inlining.');

const page = `<title>Five Nines</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=Inter:wght@400;500;600&display=swap">
<style>
${css}
html,body{background:#0b0f14;color:#d6dee8}
</style>
<div id="root"></div>
<script type="module">
${js}
</script>
`;
mkdirSync('artifact', { recursive: true });
writeFileSync('artifact/five-nines.html', page);
console.log(`Wrote artifact/five-nines.html (${page.length} bytes)`);
