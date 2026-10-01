import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
function git(...args) {
  try { return execFileSync('git', args, { cwd: new URL('.', import.meta.url), encoding: 'utf8' }).trim(); }
  catch { return ''; }
}
const revision = git('rev-parse', '--short=7', 'HEAD') || 'unknown';
const dirty = git('status', '--porcelain', '--untracked-files=no', '--', '.') ? '+dirty' : '';
const label = `${version} (${revision}${dirty})`;

export default defineConfig({
  plugins: [{ name: 'lab-build-label', transformIndexHtml(html) { return html.replaceAll('__LAB_BUILD_LABEL__', label); } }]
});
