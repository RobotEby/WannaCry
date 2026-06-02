#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';

const ALLOWED_TYPES = new Set([
  'feat',
  'fix',
  'chore',
  'refactor',
  'style',
  'docs',
  'test',
  'build',
  'ci',
  'perf',
  'revert',
]);

const ALWAYS_IGNORED_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'bin',
  'obj',
  'coverage',
  'test-results',
  'tmp',
  'temp',
  'logs',
  '.cache',
  '.vs',
  'TestResults',
  'packages',
]);

const ALWAYS_IGNORED_FILENAMES = new Set([
  'Thumbs.db',
  'Desktop.ini',
  'id_rsa',
  'id_dsa',
]);

const ALWAYS_IGNORED_EXTENSIONS = new Set([
  '.log',
  '.sqlite',
  '.sqlite3',
  '.db',
  '.dump',
  '.backup',
  '.bak',
  '.tmp',
  '.temp',
  '.swp',
  '.pid',
  '.pfx',
  '.p12',
  '.pem',
  '.key',
  '.crt',
  '.user',
  '.suo',
  '.userosscache',
  '.sln.docstates',
]);

const DANGEROUS_MESSAGE_TERMS = [
  'payload',
  'infection routine',
  'worm behavior',
  'exploit module',
  'destructive encryption',
  'encrypt files',
];

const GENERIC_MESSAGES = new Set([
  'chore: update file',
  'feat: add changes',
  'fix: fix issue',
  'refactor: update code',
  'chore: update changes',
  'feat: update file',
  'fix: update file',
]);

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const args = parseArgs(process.argv.slice(2));
const seenMessages = new Set();

main().catch((error) => {
  console.error(`\nError: ${error.message}`);
  process.exitCode = 1;
});

async function main() {
  if (args.help) {
    printUsage();
    return;
  }

  const repoRoot = getRepoRoot();
  const originalCwd = process.cwd();
  process.chdir(repoRoot);

  const repoName = path.basename(repoRoot);
  const headExists = hasHead();
  const statusEntries = getStatusEntries(repoRoot);
  const envEntries = args.includeEnv ? getUntrackedEnvEntries(repoRoot, statusEntries) : [];
  const detectedEntries = mergeEntries(statusEntries, envEntries);
  const classifiedEntries = detectedEntries.map((entry) => classifyEntry(entry, repoRoot));
  const processableEntries = [];
  const ignoredEntries = [];

  for (const entry of classifiedEntries) {
    if (entry.ignoreReason) {
      ignoredEntries.push(entry);
    } else {
      processableEntries.push(entry);
    }
  }

  logHeader({
    repoName,
    repoRoot,
    originalCwd,
    headExists,
    detectedCount: detectedEntries.length,
    processableCount: processableEntries.length,
    ignoredCount: ignoredEntries.length,
  });

  if (ignoredEntries.length > 0) {
    console.log('\nIgnored files:');
    for (const entry of ignoredEntries) {
      console.log(`- ${formatEntryPath(entry)} (${entry.ignoreReason})`);
    }
  }

  let commitsCreated = 0;
  let skipped = 0;
  let errors = 0;

  try {
    for (const entry of processableEntries) {
      console.log(`\nFile: ${formatEntryPath(entry)}`);
      console.log(`Git status: ${entry.status}`);

      const context = getEntryContext(entry, repoRoot, headExists);
      const message = makeUniqueMessage(generateCommitMessage(entry, context), entry);
      const validation = validateCommitMessage(message);

      console.log(`Generated message: ${message}`);

      if (!validation.valid) {
        console.log(`Skipped: invalid commit message (${validation.reason})`);
        skipped++;
        continue;
      }

      if (context.sensitiveReason) {
        console.log(`Skipped: ${context.sensitiveReason}`);
        skipped++;
        continue;
      }

      if (args.dryRun) {
        console.log('Dry-run: commit would be created.');
        continue;
      }

      if (!args.yes) {
        const confirmed = await confirmCommit(message);
        if (!confirmed) {
          console.log('Skipped by user.');
          skipped++;
          continue;
        }
      }

      try {
        cleanIndex(hasHead());
        stageEntry(entry);
        const stagedEntries = getStagedEntries(hasHead());
        const stagingValidation = validateStagedEntry(entry, stagedEntries);

        if (!stagingValidation.valid) {
          cleanIndex(hasHead());
          console.log(`Skipped: ${stagingValidation.reason}`);
          skipped++;
          continue;
        }

        const commitResult = runGit(['commit', '-m', message], { allowFailure: true });
        if (commitResult.status !== 0) {
          cleanIndex(hasHead());
          errors++;
          console.log(`Commit failed: ${formatGitError(commitResult)}`);
          continue;
        }

        commitsCreated++;
        console.log(`Commit created: ${firstLine(commitResult.stdout) || message}`);
      } catch (error) {
        errors++;
        console.log(`Commit failed: ${error.message}`);
      }
    }
  } finally {
    if (!args.dryRun && isInsideGitRepo()) {
      try {
        cleanIndex(hasHead());
      } catch (error) {
        console.log(`Final staging cleanup failed: ${error.message}`);
      }
    }
  }

  console.log('\nSummary:');
  console.log(`- Commits created: ${commitsCreated}`);
  console.log(`- Files ignored: ${ignoredEntries.length}`);
  console.log(`- Files skipped: ${skipped}`);
  console.log(`- Errors: ${errors}`);

  if (errors > 0) {
    process.exitCode = 1;
  }
}

function parseArgs(rawArgs) {
  const parsed = {
    yes: false,
    dryRun: false,
    includeEnv: false,
    includeDeleted: false,
    help: false,
  };

  for (const arg of rawArgs) {
    if (arg === '--yes' || arg === '-y') {
      parsed.yes = true;
    } else if (arg === '--dry-run') {
      parsed.dryRun = true;
    } else if (arg === '--include-env') {
      parsed.includeEnv = true;
    } else if (arg === '--include-deleted') {
      parsed.includeDeleted = true;
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return parsed;
}

function printUsage() {
  console.log(`Usage: node scripts/atomic-commits.mjs [options]

Options:
  --yes, -y           Accept generated messages and commit automatically
  --dry-run           Show the commit plan without staging or committing
  --include-env       Allow .env files that are ignored by default
  --include-deleted   Allow deleted files to be committed
  --help, -h          Show this help text`);
}

function logHeader({
  repoName,
  repoRoot,
  originalCwd,
  headExists,
  detectedCount,
  processableCount,
  ignoredCount,
}) {
  console.log('Atomic commit helper for WannaCry Simulator');
  console.log(`Repository: ${repoName}`);
  console.log(`Repository root: ${repoRoot}`);
  console.log(`Current directory: ${originalCwd}`);
  console.log(`HEAD exists: ${headExists ? 'yes' : 'no'}`);
  console.log(`Dry-run: ${args.dryRun ? 'yes' : 'no'}`);
  console.log(`Detected files: ${detectedCount}`);
  console.log(`Files to process: ${processableCount}`);
  console.log(`Ignored files: ${ignoredCount}`);
}

function getRepoRoot() {
  const result = runGit(['rev-parse', '--show-toplevel'], { allowFailure: true });
  if (result.status !== 0) {
    throw new Error(`not a valid Git repository (${formatGitError(result)})`);
  }

  return result.stdout.trim();
}

function isInsideGitRepo() {
  return runGit(['rev-parse', '--is-inside-work-tree'], { allowFailure: true }).status === 0;
}

function hasHead() {
  return runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFailure: true }).status === 0;
}

function getStatusEntries(repoRoot) {
  const result = runGit(['status', '--porcelain=v1', '-z']);
  const entries = parsePorcelainStatus(result.stdout);
  const expanded = [];

  for (const entry of entries) {
    if (entry.status === '??' && isDirectoryPath(repoRoot, entry.path)) {
      expanded.push(...expandUntrackedDirectory(repoRoot, entry.path));
    } else {
      expanded.push(entry);
    }
  }

  return expanded;
}

function parsePorcelainStatus(output) {
  const tokens = output.split('\0').filter((token) => token.length > 0);
  const entries = [];

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const status = token.slice(0, 2);
    const pathValue = token.slice(3);

    if (!pathValue || !isSafeRelativePath(pathValue)) {
      continue;
    }

    if (status.includes('R') || status.includes('C')) {
      const oldPath = tokens[++index];
      if (!oldPath || !isSafeRelativePath(oldPath)) {
        continue;
      }

      entries.push({
        status,
        kind: status.includes('R') ? 'rename' : 'copy',
        path: pathValue,
        newPath: pathValue,
        oldPath,
      });
    } else {
      entries.push({
        status,
        kind: status.includes('D') ? 'delete' : 'file',
        path: pathValue,
      });
    }
  }

  return entries;
}

function isDirectoryPath(repoRoot, relativePath) {
  try {
    return statSync(toFsPath(repoRoot, relativePath)).isDirectory();
  } catch {
    return relativePath.endsWith('/');
  }
}

function expandUntrackedDirectory(repoRoot, relativeDir) {
  const entries = [];
  const normalizedDir = normalizeGitPath(relativeDir).replace(/\/$/, '');

  function walk(currentRel) {
    if (!currentRel || shouldAlwaysIgnorePath(currentRel)) {
      return;
    }

    const currentFsPath = toFsPath(repoRoot, currentRel);
    let dirEntries;

    try {
      dirEntries = readdirSync(currentFsPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const dirEntry of dirEntries) {
      const childRel = normalizeGitPath(path.posix.join(currentRel, dirEntry.name));

      if (!isSafeRelativePath(childRel) || shouldAlwaysIgnorePath(childRel)) {
        continue;
      }

      if (dirEntry.isDirectory()) {
        walk(childRel);
      } else if (dirEntry.isFile()) {
        entries.push({
          status: '??',
          kind: 'file',
          path: childRel,
        });
      }
    }
  }

  walk(normalizedDir);
  return entries;
}

function getUntrackedEnvEntries(repoRoot, existingEntries) {
  const existingPaths = new Set();
  for (const entry of existingEntries) {
    for (const entryPath of entryPaths(entry)) {
      existingPaths.add(entryPath);
    }
  }

  const envEntries = [];

  function walk(currentRel) {
    const currentFsPath = currentRel ? toFsPath(repoRoot, currentRel) : repoRoot;
    let dirEntries;

    try {
      dirEntries = readdirSync(currentFsPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const dirEntry of dirEntries) {
      const childRel = normalizeGitPath(currentRel ? path.posix.join(currentRel, dirEntry.name) : dirEntry.name);

      if (!isSafeRelativePath(childRel) || childRel === '.git' || shouldAlwaysIgnorePath(childRel)) {
        continue;
      }

      if (dirEntry.isDirectory()) {
        walk(childRel);
        continue;
      }

      if (!dirEntry.isFile() || existingPaths.has(childRel)) {
        continue;
      }

      if (isProtectedEnvFile(childRel) && !isAllowedEnvExample(childRel)) {
        envEntries.push({
          status: '??',
          kind: 'file',
          path: childRel,
          forceAdd: true,
        });
      }
    }
  }

  walk('');
  return envEntries;
}

function mergeEntries(primaryEntries, secondaryEntries) {
  const seen = new Set();
  const merged = [];

  for (const entry of [...primaryEntries, ...secondaryEntries]) {
    const key = `${entry.status}:${entry.oldPath || ''}:${entry.path}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    merged.push(entry);
  }

  return merged;
}

function classifyEntry(entry, repoRoot) {
  const classified = { ...entry };
  const paths = entryPaths(entry);

  if (paths.some((entryPath) => !isSafeRelativePath(entryPath))) {
    classified.ignoreReason = 'unsafe path';
    return classified;
  }

  if (paths.some((entryPath) => shouldAlwaysIgnorePath(entryPath))) {
    classified.ignoreReason = 'always ignored by safety policy';
    return classified;
  }

  if (!args.includeEnv && paths.some((entryPath) => isProtectedEnvFile(entryPath) && !isAllowedEnvExample(entryPath))) {
    classified.ignoreReason = 'environment file ignored by default';
    return classified;
  }

  if (!args.includeDeleted && isDeletedEntry(entry)) {
    classified.ignoreReason = 'deleted file ignored by default';
    return classified;
  }

  if (paths.some((entryPath) => isPotentiallySensitivePath(entryPath))) {
    classified.ignoreReason = 'potentially sensitive file ignored';
    return classified;
  }

  if (entry.kind !== 'delete' && paths.every((entryPath) => !existsSync(toFsPath(repoRoot, entryPath)))) {
    classified.ignoreReason = 'file missing from working tree';
    return classified;
  }

  return classified;
}

function entryPaths(entry) {
  if (entry.kind === 'rename' || entry.kind === 'copy') {
    return [entry.oldPath, entry.newPath].filter(Boolean);
  }

  return [entry.path].filter(Boolean);
}

function isDeletedEntry(entry) {
  return entry.kind === 'delete' || entry.status.includes('D');
}

function shouldAlwaysIgnorePath(relativePath) {
  const normalized = normalizeGitPath(relativePath).replace(/\/$/, '');
  const segments = normalized.split('/');
  const basename = segments[segments.length - 1];
  const lowercaseBasename = basename.toLowerCase();
  const lowercasePath = normalized.toLowerCase();

  if (normalized === '.git' || normalized.startsWith('.git/')) {
    return true;
  }

  if (lowercasePath === '.vscode/.history' || lowercasePath.startsWith('.vscode/.history/')) {
    return true;
  }

  if (segments.some((segment) => ALWAYS_IGNORED_DIRS.has(segment))) {
    return true;
  }

  if (ALWAYS_IGNORED_FILENAMES.has(basename)) {
    return true;
  }

  if (lowercaseBasename.endsWith('.sln.docstates')) {
    return true;
  }

  for (const extension of ALWAYS_IGNORED_EXTENSIONS) {
    if (lowercaseBasename.endsWith(extension)) {
      return true;
    }
  }

  return false;
}

function isProtectedEnvFile(relativePath) {
  const basename = path.posix.basename(relativePath);
  return basename === '.env' || basename.startsWith('.env.');
}

function isAllowedEnvExample(relativePath) {
  const basename = path.posix.basename(relativePath);
  return basename === '.env.example' || basename === '.env.staging.example';
}

function isPotentiallySensitivePath(relativePath) {
  const basename = path.posix.basename(relativePath).toLowerCase();
  return (
    basename.includes('secret') ||
    basename.includes('credential') ||
    basename.includes('private-key') ||
    basename.includes('private_key')
  );
}

function getEntryContext(entry, repoRoot, headExists) {
  const primaryPath = entry.newPath || entry.path;
  const readablePath = entry.kind === 'delete' ? null : primaryPath;
  const content = readablePath ? readSmallTextFile(repoRoot, readablePath) : '';
  const diff = getDiffForEntry(entry, headExists);
  const sensitiveReason = detectSensitiveContent(primaryPath, content);

  return {
    content,
    diff,
    text: `${diff}\n${content}`.toLowerCase(),
    sensitiveReason,
  };
}

function getDiffForEntry(entry, headExists) {
  const targetPath = entry.newPath || entry.path;
  if (!targetPath) {
    return '';
  }

  const worktreeDiff = runGit(['diff', '--', targetPath], { allowFailure: true });
  if (worktreeDiff.status === 0 && worktreeDiff.stdout.trim()) {
    return worktreeDiff.stdout;
  }

  if (!headExists && existsSync(toFsPath(process.cwd(), targetPath))) {
    return readSmallTextFile(process.cwd(), targetPath);
  }

  return '';
}

function readSmallTextFile(repoRoot, relativePath) {
  const fsPath = toFsPath(repoRoot, relativePath);

  try {
    const stats = statSync(fsPath);
    if (!stats.isFile() || stats.size > 256 * 1024) {
      return '';
    }

    const buffer = readFileSync(fsPath);
    if (buffer.includes(0)) {
      return '';
    }

    return buffer.toString('utf8');
  } catch {
    return '';
  }
}

function detectSensitiveContent(relativePath, content) {
  if (!content) {
    return '';
  }

  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(content) || /-----BEGIN (RSA|DSA|EC|OPENSSH) PRIVATE KEY-----/.test(content)) {
    return 'private key material detected';
  }

  if (isProtectedEnvFile(relativePath) && !isAllowedEnvExample(relativePath)) {
    const sensitiveAssignment = /^\s*(?:[A-Z0-9_]*?(?:SECRET|TOKEN|PASSWORD|PASS|PRIVATE_KEY|API_KEY|ACCESS_KEY)[A-Z0-9_]*)\s*=\s*["']?([^"'\s#][^"'\n#]*)/gim;
    let match;

    while ((match = sensitiveAssignment.exec(content)) !== null) {
      const value = match[1].trim().toLowerCase();
      if (!isPlaceholderSecretValue(value)) {
        return 'potential credential detected in environment file';
      }
    }
  }

  return '';
}

function isPlaceholderSecretValue(value) {
  return (
    value === '' ||
    value === 'example' ||
    value === 'changeme' ||
    value === 'change-me' ||
    value === 'placeholder' ||
    value === 'dummy' ||
    value === 'test' ||
    value === 'dev' ||
    value === 'local' ||
    value === 'none' ||
    value === 'null' ||
    value === 'your_value_here' ||
    value.startsWith('your_') ||
    value.startsWith('example_') ||
    value.startsWith('dummy_') ||
    value.includes('xxxx')
  );
}

function generateCommitMessage(entry, context) {
  const primaryPath = entry.newPath || entry.path;
  const normalizedPath = normalizeGitPath(primaryPath);
  const filename = path.posix.basename(normalizedPath);
  const lowercasePath = normalizedPath.toLowerCase();
  const lowercaseName = filename.toLowerCase();
  const extension = getLowercaseExtension(filename);
  const text = context.text;

  if (entry.kind === 'rename') {
    return makeMessage(typeForRename(normalizedPath), `rename ${humanizePath(entry.oldPath)} to ${humanizePath(entry.newPath)}`);
  }

  if (isDeletedEntry(entry)) {
    return makeMessage(typeForPath(normalizedPath, text, entry), `remove ${safeFileDescription(normalizedPath)}`);
  }

  if (isDocsPath(lowercasePath)) {
    if (text.includes('disclaimer') || text.includes('defensive') || text.includes('non-destructive') || text.includes('laboratory')) {
      return 'docs: add defensive security disclaimer';
    }

    if (text.includes('recover') || text.includes('restore')) {
      return 'docs: explain recovery tool workflow';
    }

    return 'docs: document safe laboratory usage';
  }

  if (isAllowedEnvExample(normalizedPath)) {
    return 'chore: add example environment configuration';
  }

  if (isProtectedEnvFile(normalizedPath)) {
    return 'chore: update environment configuration';
  }

  if (isCiPath(lowercasePath)) {
    return 'ci: add repository validation workflow';
  }

  if (isTestPath(lowercasePath)) {
    return makeMessage('test', `add ${safeFileDescription(normalizedPath)} coverage`);
  }

  if (isGitOrIdeConfig(lowercasePath)) {
    if (lowercaseName === '.gitignore') {
      return 'chore: add safe repository ignore rules';
    }

    return 'chore: update development tooling configuration';
  }

  if (lowercaseName === 'package.json' || lowercaseName === 'package-lock.json') {
    return 'chore: add atomic commit npm scripts';
  }

  if (lowercasePath === 'scripts/atomic-commits.mjs') {
    return 'chore: add atomic commit automation script';
  }

  if (isBuildConfigPath(lowercasePath)) {
    if (lowercaseName === 'assemblyinfo.cs') {
      return 'build: update simulator assembly metadata';
    }

    return 'build: update Visual Studio project configuration';
  }

  if (isAssetPath(lowercasePath, extension)) {
    if (lowercasePath.includes('/resources/') || lowercasePath.includes('wanadecryptor')) {
      return 'feat: add WannaCry simulator visual asset';
    }

    return 'chore: update simulator visual asset';
  }

  if (lowercasePath.endsWith('/properties/resources.resx')) {
    return 'feat: add WannaCry simulator resource manifest';
  }

  if (lowercasePath.endsWith('/properties/settings.settings') || lowercaseName === 'settings.settings') {
    return 'build: update simulator settings configuration';
  }

  if (isRecoveryPath(lowercasePath)) {
    if (text.includes('.wncry') || text.includes('restore') || text.includes('recover')) {
      return 'feat: add safe recovery console tool';
    }

    if (text.includes('wallpaper')) {
      return 'feat: add controlled wallpaper recovery workflow';
    }

    return 'refactor: reorganize recovery console behavior';
  }

  if (isWindowsFormsPath(lowercasePath, extension)) {
    if (lowercaseName === 'form1.resx') {
      return 'feat: add WannaCry simulation interface resources';
    }

    if (lowercaseName === 'form2.resx') {
      return 'feat: add simulated ransom note dialog resources';
    }

    if (text.includes('timer') || text.includes('countdown')) {
      return 'feat: add countdown timer interface';
    }

    if (lowercaseName.includes('form2')) {
      return 'feat: add simulated ransom note dialog';
    }

    if (text.includes('button') || text.includes('label') || text.includes('richtextbox') || text.includes('textbox') || text.includes('combobox')) {
      return 'feat: add WannaCry simulation interface';
    }

    return 'refactor: organize WannaCry simulator interface code';
  }

  if (lowercaseName === 'program.cs') {
    if (text.includes('wallpaper') || text.includes('background')) {
      return 'feat: implement wallpaper simulation behavior';
    }

    if (text.includes('.wncry') || text.includes('directory') || text.includes('extension')) {
      return 'feat: add safe file extension simulator';
    }

    if (hasNetworkSimulationText(text)) {
      return 'feat: add lab network detection simulation';
    }

    return 'refactor: separate simulator startup workflow';
  }

  if (hasWallpaperText(lowercasePath, text)) {
    if (hasSafetyFixText(text)) {
      return 'fix: handle missing wallpaper resource safely';
    }

    return 'feat: implement wallpaper simulation behavior';
  }

  if (hasExtensionSimulationText(lowercasePath, text)) {
    if (hasSafetyFixText(text) || text.includes('subdirector') || text.includes('executable') || text.includes('.exe')) {
      return 'fix: restrict extension simulation to current directory';
    }

    return 'feat: add safe file extension simulator';
  }

  if (hasNetworkSimulationText(text)) {
    if (hasSafetyFixText(text) || text.includes('timeout') || text.includes('192.168') || text.includes('lab')) {
      return 'fix: prevent unsafe network scan defaults';
    }

    return 'feat: add lab-only network activity simulation';
  }

  if (extension === '.cs') {
    return makeMessage(typeForPath(normalizedPath, text, entry), `organize ${safeFileDescription(normalizedPath)}`);
  }

  return makeMessage(typeForPath(normalizedPath, text, entry), `update ${safeFileDescription(normalizedPath)}`);
}

function typeForPath(normalizedPath, text, entry) {
  const lowercasePath = normalizedPath.toLowerCase();
  const extension = getLowercaseExtension(normalizedPath);

  if (isDeletedEntry(entry)) {
    if (isDocsPath(lowercasePath)) return 'docs';
    if (isBuildConfigPath(lowercasePath)) return 'build';
    if (isTestPath(lowercasePath)) return 'test';
    return 'chore';
  }

  if (isDocsPath(lowercasePath)) return 'docs';
  if (isCiPath(lowercasePath)) return 'ci';
  if (isTestPath(lowercasePath)) return 'test';
  if (isBuildConfigPath(lowercasePath)) return 'build';
  if (isGitOrIdeConfig(lowercasePath)) return 'chore';
  if (hasSafetyFixText(text)) return 'fix';
  if (text.includes('performance') || text.includes('optimiz')) return 'perf';
  if (extension === '.cs' || extension === '.resx' || extension === '.settings') return 'feat';
  return entry.status === '??' || entry.status.includes('A') ? 'feat' : 'chore';
}

function typeForRename(normalizedPath) {
  const lowercasePath = normalizedPath.toLowerCase();
  if (isDocsPath(lowercasePath)) return 'docs';
  if (isBuildConfigPath(lowercasePath)) return 'build';
  if (isGitOrIdeConfig(lowercasePath)) return 'chore';
  return 'refactor';
}

function makeMessage(type, subject) {
  return `${type}: ${normalizeSubject(subject)}`;
}

function normalizeSubject(subject) {
  return subject
    .replace(/\s+/g, ' ')
    .replace(/\.$/, '')
    .trim();
}

function makeUniqueMessage(message, entry) {
  let candidate = normalizeMessage(message);

  if (!seenMessages.has(candidate)) {
    seenMessages.add(candidate);
    return candidate;
  }

  const [type, subject] = splitMessage(candidate);
  const qualifier = humanizeName(path.posix.basename(entry.newPath || entry.path, path.posix.extname(entry.newPath || entry.path)));
  candidate = `${type}: ${subject} for ${qualifier}`;
  candidate = normalizeMessage(candidate);

  if (!seenMessages.has(candidate) && validateCommitMessage(candidate).valid) {
    seenMessages.add(candidate);
    return candidate;
  }

  const pathQualifier = humanizePath(entry.newPath || entry.path);
  candidate = normalizeMessage(`${type}: ${subject} in ${pathQualifier}`);
  seenMessages.add(candidate);
  return candidate;
}

function normalizeMessage(message) {
  const [type, subject] = splitMessage(message);
  return `${type}: ${normalizeSubject(subject)}`;
}

function splitMessage(message) {
  const match = message.match(/^([a-z]+):\s*(.+)$/);
  if (!match) {
    return ['chore', message.trim()];
  }

  return [match[1], match[2]];
}

function validateCommitMessage(message) {
  const prefixMatch = message.match(/^([a-z]+)(\([^)]*\))?:\s*(.+)$/);
  if (!prefixMatch) {
    return { valid: false, reason: 'message must use Conventional Commits format' };
  }

  const [, type, scope, subject] = prefixMatch;

  if (!ALLOWED_TYPES.has(type)) {
    return { valid: false, reason: `unsupported type "${type}"` };
  }

  if (scope) {
    return { valid: false, reason: 'scopes are not allowed' };
  }

  if (!subject.trim()) {
    return { valid: false, reason: 'subject is empty' };
  }

  if (message.length > 110) {
    return { valid: false, reason: 'message is too long' };
  }

  if (/[^\x00-\x7F]/.test(subject)) {
    return { valid: false, reason: 'message must be English ASCII text' };
  }

  const lowercaseMessage = message.toLowerCase();

  if (GENERIC_MESSAGES.has(lowercaseMessage)) {
    return { valid: false, reason: 'message is too generic' };
  }

  for (const term of DANGEROUS_MESSAGE_TERMS) {
    if (lowercaseMessage.includes(term)) {
      return { valid: false, reason: `unsafe wording "${term}"` };
    }
  }

  return { valid: true };
}

function cleanIndex(headExists) {
  if (headExists) {
    const reset = runGit(['reset', '--quiet', 'HEAD', '--'], { allowFailure: true });
    if (reset.status === 0) {
      return;
    }
  }

  const rmCached = runGit(['rm', '-r', '--cached', '--quiet', '--ignore-unmatch', '--', '.'], { allowFailure: true });
  if (rmCached.status !== 0) {
    throw new Error(`unable to clean staging area (${formatGitError(rmCached)})`);
  }
}

function stageEntry(entry) {
  const paths = entry.kind === 'rename' || entry.kind === 'copy'
    ? [entry.oldPath, entry.newPath].filter(Boolean)
    : [entry.path];

  const addArgs = ['add'];
  if (entry.forceAdd || paths.some((entryPath) => isProtectedEnvFile(entryPath) && !isAllowedEnvExample(entryPath))) {
    addArgs.push('-f');
  }

  addArgs.push('--', ...paths);

  const result = runGit(addArgs, { allowFailure: true });
  if (result.status !== 0) {
    throw new Error(`unable to stage ${formatEntryPath(entry)} (${formatGitError(result)})`);
  }
}

function getStagedEntries(headExists) {
  const argsForDiff = headExists
    ? ['diff', '--cached', '--name-status', '-M', '-z', '--']
    : ['diff', '--cached', '--name-status', '-M', '-z', EMPTY_TREE, '--'];
  const result = runGit(argsForDiff, { allowFailure: true });

  if (result.status !== 0) {
    return getStagedEntriesFromStatus();
  }

  return parseNameStatus(result.stdout);
}

function getStagedEntriesFromStatus() {
  return parsePorcelainStatus(runGit(['status', '--porcelain=v1', '-z']).stdout)
    .filter((entry) => entry.status[0] !== ' ' && entry.status !== '??');
}

function parseNameStatus(output) {
  const tokens = output.split('\0').filter((token) => token.length > 0);
  const entries = [];

  for (let index = 0; index < tokens.length; index++) {
    const status = tokens[index];

    if (status.startsWith('R') || status.startsWith('C')) {
      const oldPath = tokens[++index];
      const newPath = tokens[++index];
      entries.push({
        status,
        kind: status.startsWith('R') ? 'rename' : 'copy',
        oldPath,
        newPath,
        path: newPath,
      });
    } else {
      const entryPath = tokens[++index];
      entries.push({
        status,
        kind: status.startsWith('D') ? 'delete' : 'file',
        path: entryPath,
      });
    }
  }

  return entries;
}

function validateStagedEntry(expectedEntry, stagedEntries) {
  if (stagedEntries.length !== 1) {
    return {
      valid: false,
      reason: `expected exactly one staged change, found ${stagedEntries.length}`,
    };
  }

  const expectedPaths = new Set(entryPaths(expectedEntry));
  const stagedPaths = new Set(entryPaths(stagedEntries[0]));

  for (const stagedPath of stagedPaths) {
    if (!expectedPaths.has(stagedPath)) {
      return {
        valid: false,
        reason: `unexpected staged path ${stagedPath}`,
      };
    }
  }

  return { valid: true };
}

function confirmCommit(message) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`Commit with "${message}"? [y/N] `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes');
    });
  });
}

function runGit(gitArgs, options = {}) {
  const result = spawnSync('git', gitArgs, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });

  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`git ${gitArgs.join(' ')} failed (${formatGitError(result)})`);
  }

  return {
    status: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function formatGitError(result) {
  return firstLine(result.stderr) || firstLine(result.stdout) || `exit code ${result.status}`;
}

function firstLine(value) {
  return String(value || '').trim().split(/\r?\n/)[0] || '';
}

function formatEntryPath(entry) {
  if (entry.kind === 'rename') {
    return `${entry.oldPath} -> ${entry.newPath}`;
  }

  if (entry.kind === 'copy') {
    return `${entry.oldPath} => ${entry.newPath}`;
  }

  return entry.path;
}

function normalizeGitPath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function toFsPath(repoRoot, relativePath) {
  return path.join(repoRoot, ...normalizeGitPath(relativePath).split('/'));
}

function isSafeRelativePath(relativePath) {
  const normalized = normalizeGitPath(relativePath);
  return (
    normalized.length > 0 &&
    !path.posix.isAbsolute(normalized) &&
    !normalized.split('/').includes('..') &&
    !normalized.includes('\0')
  );
}

function getLowercaseExtension(filename) {
  const lowercaseName = filename.toLowerCase();
  if (lowercaseName.endsWith('.sln.docstates')) {
    return '.sln.docstates';
  }

  return path.posix.extname(lowercaseName);
}

function isDocsPath(lowercasePath) {
  return (
    lowercasePath === 'readme.md' ||
    lowercasePath.startsWith('docs/') ||
    lowercasePath.endsWith('.md') ||
    lowercasePath.endsWith('.markdown') ||
    lowercasePath.includes('/readme.')
  );
}

function isCiPath(lowercasePath) {
  return lowercasePath.startsWith('.github/workflows/') || lowercasePath.includes('/workflows/');
}

function isTestPath(lowercasePath) {
  return (
    lowercasePath.startsWith('test/') ||
    lowercasePath.startsWith('tests/') ||
    lowercasePath.includes('/test/') ||
    lowercasePath.includes('/tests/') ||
    lowercasePath.endsWith('.test.cs') ||
    lowercasePath.endsWith('.tests.cs')
  );
}

function isGitOrIdeConfig(lowercasePath) {
  const basename = path.posix.basename(lowercasePath);
  return (
    basename === '.gitignore' ||
    basename === '.editorconfig' ||
    lowercasePath.startsWith('.vscode/') ||
    lowercasePath.startsWith('.idea/')
  );
}

function isBuildConfigPath(lowercasePath) {
  return (
    lowercasePath.endsWith('.csproj') ||
    lowercasePath.endsWith('.sln') ||
    lowercasePath.endsWith('assemblyinfo.cs') ||
    lowercasePath.endsWith('app.config') ||
    lowercasePath.endsWith('packages.config')
  );
}

function isAssetPath(lowercasePath, extension) {
  return (
    lowercasePath.includes('/resources/') ||
    ['.bmp', '.ico', '.png', '.jpg', '.jpeg'].includes(extension)
  );
}

function isRecoveryPath(lowercasePath) {
  return lowercasePath.startsWith('anti_wannacry/') || lowercasePath.includes('/anti_wannacry/');
}

function isWindowsFormsPath(lowercasePath, extension) {
  const filename = path.posix.basename(lowercasePath);
  return (
    filename === 'form1.cs' ||
    filename === 'form2.cs' ||
    filename === 'form1.designer.cs' ||
    filename === 'form2.designer.cs' ||
    filename === 'form1.resx' ||
    filename === 'form2.resx' ||
    extension === '.resx'
  );
}

function hasWallpaperText(lowercasePath, text) {
  return (
    lowercasePath.includes('wallpaper') ||
    text.includes('wallpaper') ||
    text.includes('desktop background') ||
    text.includes('systemparametersinfo') ||
    text.includes('spi_setdeskwallpaper')
  );
}

function hasExtensionSimulationText(lowercasePath, text) {
  return (
    lowercasePath.includes('extension') ||
    text.includes('.wncry') ||
    text.includes('getfiles') ||
    text.includes('movefile') ||
    text.includes('rename') ||
    text.includes('extension')
  );
}

function hasNetworkSimulationText(text) {
  return (
    text.includes('445') ||
    text.includes('tcp') ||
    text.includes('socket') ||
    text.includes('192.168') ||
    text.includes('iuqerfsodp9ifjaposdfjhgosurijfaewrwergwea.com')
  );
}

function hasSafetyFixText(text) {
  return (
    text.includes('safe') ||
    text.includes('guard') ||
    text.includes('prevent') ||
    text.includes('restrict') ||
    text.includes('skip') ||
    text.includes('validate') ||
    text.includes('missing') ||
    text.includes('permission') ||
    text.includes('timeout') ||
    text.includes('non-destructive') ||
    text.includes('lab')
  );
}

function safeFileDescription(relativePath) {
  const lowercasePath = relativePath.toLowerCase();
  const filename = path.posix.basename(relativePath);
  const extension = getLowercaseExtension(filename);

  if (lowercasePath === 'readme.md') return 'safe simulator documentation';
  if (isAllowedEnvExample(relativePath)) return 'example environment configuration';
  if (isProtectedEnvFile(relativePath)) return 'environment configuration';
  if (lowercasePath === 'package.json') return 'atomic commit npm scripts';
  if (lowercasePath === '.gitignore') return 'safe repository ignore rules';
  if (lowercasePath === 'scripts/atomic-commits.mjs') return 'atomic commit automation script';
  if (isBuildConfigPath(lowercasePath)) return 'Visual Studio project configuration';
  if (isAssetPath(lowercasePath, extension)) return 'WannaCry simulator visual asset';
  if (isRecoveryPath(lowercasePath)) return 'safe recovery console workflow';
  if (isWindowsFormsPath(lowercasePath, extension)) return 'WannaCry simulator interface';
  return `${humanizeName(path.posix.basename(relativePath, path.posix.extname(relativePath)))} file`;
}

function humanizePath(relativePath) {
  return normalizeGitPath(relativePath)
    .replace(/\.[^/.]+$/, '')
    .split('/')
    .map(humanizeName)
    .filter(Boolean)
    .join(' ');
}

function humanizeName(value) {
  return String(value || '')
    .replace(/^@+|@+$/g, '')
    .replace(/[_\-.]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
