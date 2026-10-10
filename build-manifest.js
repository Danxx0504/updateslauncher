const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const upload = args.includes('--upload');
const [sourceDir, releaseBaseUrl] = args.filter((arg) => !arg.startsWith('--'));
const outputDir = 'dist';

function listFlag(name) {
  const found = args.find((arg) => arg.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3).split(',').map((item) => item.trim()).filter(Boolean) : [];
}

const target = (releaseBaseUrl || '').match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/download\/([^/]+)\/?$/);

if (!sourceDir || !target) {
  console.error('Uso: node build-manifest.js <carpeta-instancia> https://github.com/USUARIO/REPO/releases/download/TAG [--exclude=a,b] [--keep=a,b] [--upload]');
  process.exit(1);
}

const repo = target[1];
const tag = target[2];
const baseUrl = releaseBaseUrl.replace(/\/+$/, '');

const EXCLUDED = new Set(['versions', 'libraries', 'assets', 'loader', 'runtime', 'saves', 'logs', 'crash-reports', 'screenshots', ...listFlag('exclude')]);
const KEEP = ['options.txt', 'servers.dat', ...listFlag('keep')];

function walk(dir, base = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = base ? `${base}/${entry.name}` : entry.name;
    if (!base && (EXCLUDED.has(entry.name) || entry.name.startsWith('.'))) return [];
    if (entry.name.endsWith('.spyderpart')) return [];
    if (entry.isDirectory()) return walk(path.join(dir, entry.name), relativePath);
    return [relativePath];
  });
}

function listExistingAssets() {
  try {
    const output = execFileSync('gh', ['release', 'view', tag, '--repo', repo, '--json', 'assets', '--jq', '.assets[].name'], { encoding: 'utf-8' });
    return new Set(output.split(/\r?\n/).filter(Boolean));
  } catch (err) {
    return new Set();
  }
}

const existing = listExistingAssets();
fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });

const toUpload = [];
const emptyFiles = [];
const files = walk(sourceDir).map((relativePath) => {
  const content = fs.readFileSync(path.join(sourceDir, relativePath));
  const sha1 = crypto.createHash('sha1').update(content).digest('hex');
  if (content.length === 0) {
    emptyFiles.push(relativePath);
  } else if (!existing.has(sha1) && !toUpload.includes(sha1)) {
    fs.writeFileSync(path.join(outputDir, sha1), content);
    toUpload.push(sha1);
  }
  return { path: relativePath, sha1, size: content.length, url: `${baseUrl}/${sha1}` };
});

const manifest = { version: Date.now(), keep: KEEP, files };
fs.writeFileSync(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`${files.length} archivos en el manifest, ${toUpload.length} nuevos para subir`);
if (emptyFiles.length > 0) {
  console.log(`${emptyFiles.length} archivos vacíos (el launcher los crea sin descargarlos):`);
  emptyFiles.forEach((name) => console.log(`  ${name}`));
}

if (upload) {
  const BATCH_SIZE = 20;
  const paths = toUpload.map((name) => path.join(outputDir, name));
  for (let index = 0; index < paths.length; index += BATCH_SIZE) {
    execFileSync('gh', ['release', 'upload', tag, '--repo', repo, '--clobber', ...paths.slice(index, index + BATCH_SIZE)], { stdio: 'inherit' });
  }
  execFileSync('gh', ['release', 'upload', tag, '--repo', repo, '--clobber', path.join(outputDir, 'manifest.json')], { stdio: 'inherit' });
}