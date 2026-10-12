#!/usr/bin/env node
// Installs tools/pre-commit (refuses commits that add secret keys) in both webshop repositories:
// this code repository and the content repository (config.json "sourcesDir").
//
//   node tools/install-hooks.mjs
//
// Git hooks are not part of a repository, so run this again after cloning either repository.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const hook = fs.readFileSync(path.join(ROOT, 'tools', 'pre-commit'));

for (const repo of [ROOT, path.resolve(ROOT, cfg.sourcesDir)]) {
  const hooks = path.join(repo, '.git', 'hooks');
  if (!fs.existsSync(hooks)) { console.log(`- ${repo}: not a git repository, skipped`); continue; }
  fs.writeFileSync(path.join(hooks, 'pre-commit'), hook, { mode: 0o755 });
  console.log(`+ ${repo}: pre-commit check installed`);
}
