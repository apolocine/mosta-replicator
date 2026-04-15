#!/usr/bin/env node
// mostajs-replicator-scaffold — standalone CLI for scaffoldReplicatorService().
// Author: Dr Hamid MADANI drmdh@msn.com
//
// Usage :
//   npx @mostajs/replicator scaffold [--dir .] [--path services/replicator.mjs] [--force] [--dry-run]

import { scaffoldReplicatorService } from './scaffold.js';

const argv = process.argv.slice(2);
const val = (name: string, def?: string) => {
  const i = argv.indexOf('--' + name);
  return i < 0 ? def : (argv[i + 1] ?? def);
};
const has = (name: string) => argv.includes('--' + name);

if (has('help') || has('h')) {
  console.log(`
  mostajs-replicator-scaffold — emit services/replicator.mjs into a project

    --dir      <path>    project root                (default: cwd)
    --path     <path>    output file relative to dir (default: services/replicator.mjs)
    --force              overwrite if it exists
    --dry-run            print what would be written, don't touch disk
`);
  process.exit(0);
}

const result = scaffoldReplicatorService({
  projectDir: val('dir'),
  servicePath: val('path'),
  force: has('force'),
  dryRun: has('dry-run'),
});

if (result.action === 'dry-run') {
  console.log(`[dry-run] would write ${result.path} (${result.content.length} bytes)`);
  console.log('--- preview (first 30 lines) ---');
  console.log(result.content.split('\n').slice(0, 30).join('\n'));
  console.log('---');
} else if (result.wrote) {
  console.log(`✓ ${result.action} : ${result.path}`);
  console.log(`\nNext step : add \"replicator\": \"node ${result.path.replace(/^.*\/(?=services)/, '')}\" to your package.json scripts.`);
} else {
  console.log(`• ${result.action} : ${result.path}`);
  console.log(`  (use --force to overwrite)`);
}
