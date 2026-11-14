// Runs first in `npm run deploy`. Stops the deploy when GitHub has changes this copy lacks,
// so a stale copy can't replace what's live on vva227.org.
import { execFileSync } from 'node:child_process';

const REMOTE = 'origin/main';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function stop(lines) {
  console.error('\nDEPLOY STOPPED\n');
  for (const line of lines) console.error(line);
  console.error('');
  process.exit(1);
}

let behind;
let ahead;
try {
  git('fetch', 'origin');
  behind = Number(git('rev-list', '--count', `HEAD..${REMOTE}`));
  ahead = Number(git('rev-list', '--count', `${REMOTE}..HEAD`));
} catch {
  stop([
    'Could not check GitHub for newer changes. Is git installed, and are you online?',
    'Deploying from an out-of-date copy can overwrite other people’s live work, so nothing was deployed.',
  ]);
}

if (behind > 0) {
  stop([
    `GitHub has ${behind} newer change${behind === 1 ? '' : 's'} that this copy does not have.`,
    'Deploying now would replace the live site with an older version.',
    '',
    'To fix it: run  git pull  in this folder, then run the deploy again.',
  ]);
}

if (ahead > 0) {
  console.log(`Note: ${ahead} commit${ahead === 1 ? '' : 's'} here ${ahead === 1 ? 'is' : 'are'} not on GitHub yet. Run  git push  after this deploy.`);
}
if (git('status', '--porcelain', '--untracked-files=no')) {
  console.log('Note: there are uncommitted changes. They will be deployed, but they are not saved in git yet.');
}
console.log('Sync check passed: this copy includes everything on GitHub.');
