#!/usr/bin/env node
import { chmod, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

const root = fileURLToPath(new URL('..', import.meta.url));
const sourceDirectory = join(root, 'src');
const outputDirectory = join(root, 'dist');

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

const files = await listTypeScriptFiles(sourceDirectory);

for (const sourcePath of files) {
  const relativePath = relative(sourceDirectory, sourcePath);
  const outputPath = join(outputDirectory, relativePath.replace(/\.ts$/, '.js'));
  const source = await readFile(sourcePath, 'utf8');
  const stripped = stripTypeScriptTypes(source, { mode: 'strip' });
  const javascript = rewriteTypeScriptSpecifiers(stripped);

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, javascript, 'utf8');

  if (source.startsWith('#!')) {
    await chmod(outputPath, 0o755);
  }
}

console.log(`Built ${files.length} TypeScript files into dist/`);

async function listTypeScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...await listTypeScriptFiles(path));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(path);
    }
  }

  return files.sort();
}

function rewriteTypeScriptSpecifiers(source) {
  return source
    .replace(/((?:from|import)\s*\(?\s*['"][^'"]+)\.ts(['"]\)?)/g, '$1.js$2')
    .replace(/(import\.meta\.resolve\(\s*['"][^'"]+)\.ts(['"]\s*\))/g, '$1.js$2');
}
