/** Fixed worker program passed to `node -e`; request data is read only from stdin. */
export const SANDBOX_WORKER_SOURCE = String.raw`
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const PROTOCOL = 1;
const ROOT = '/workspace';
const MAX_FILE_BYTES = 1024 * 1024;
const GREP_READ_BATCH_SIZE = 8;
const BLOCKED_SEGMENTS = new Set(['.git', '.pi', '.ssh', '.aws', '.gnupg']);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function relativePath(value, allowDot = false) {
  if (typeof value !== 'string' || value.includes('\0')) fail('SANDBOX_INVALID_PATH');
  const normalized = value.replaceAll('\\', '/');
  if (normalized.startsWith('/') || normalized.startsWith('//') || /^[A-Za-z]:/.test(normalized)) fail('SANDBOX_PATH_ESCAPE');
  const parts = normalized.split('/').filter((part) => part && part !== '.');
  if (parts.some((part) => part === '..' || BLOCKED_SEGMENTS.has(part))) fail('SANDBOX_PATH_ESCAPE');
  if (!allowDot && parts.length === 0) fail('SANDBOX_INVALID_PATH');
  return parts.join('/');
}

function inside(candidate) {
  const resolved = path.resolve(ROOT, candidate);
  if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) fail('SANDBOX_PATH_ESCAPE');
  return resolved;
}

async function assertRealInside(target, mayNotExist = false) {
  let probe = target;
  while (true) {
    try {
      const real = await fsp.realpath(probe);
      if (real !== ROOT && !real.startsWith(ROOT + path.sep)) fail('SANDBOX_SYMLINK_ESCAPE');
      return;
    } catch (error) {
      if (!mayNotExist || (error && error.code !== 'ENOENT')) throw error;
      const parent = path.dirname(probe);
      if (parent === probe) throw error;
      probe = parent;
    }
  }
}

async function target(value, options = {}) {
  const rel = relativePath(value, options.allowDot === true);
  const absolute = inside(rel);
  await assertRealInside(absolute, options.mayNotExist === true);
  return { rel, absolute };
}

function digest(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function globRegex(pattern) {
  if (typeof pattern !== 'string' || pattern.length === 0 || pattern.length > 512) fail('SANDBOX_INVALID_GLOB');
  let output = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') { output += '.*'; i++; }
      else output += '[^/]*';
    } else if (c === '?') output += '[^/]';
    else if ('\\.^$+{}()|[]'.includes(c)) output += '\\' + c;
    else output += c;
  }
  return new RegExp(output + '$', 'u');
}

async function walk(root, limit) {
  const found = [];
  async function visit(directory, prefix) {
    if (found.length >= limit) return;
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (BLOCKED_SEGMENTS.has(entry.name) || entry.name === 'node_modules') continue;
      const rel = prefix ? prefix + '/' + entry.name : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        await assertRealInside(absolute);
        continue;
      }
      found.push({ rel, absolute, directory: entry.isDirectory() });
      if (found.length >= limit) return;
      if (entry.isDirectory()) await visit(absolute, rel);
    }
  }
  await visit(root, '');
  return found;
}

async function atomicWrite(absolute, content) {
  const parent = path.dirname(absolute);
  await fsp.mkdir(parent, { recursive: true });
  await assertRealInside(parent);
  try {
    const stat = await fsp.lstat(absolute);
    if (stat.isSymbolicLink() || stat.nlink > 1) fail('SANDBOX_UNSAFE_WRITE_TARGET');
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  const temporary = path.join(parent, '.pi-sandbox-' + crypto.randomUUID());
  try {
    await fsp.writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
    await fsp.rename(temporary, absolute);
  } finally {
    await fsp.rm(temporary, { force: true }).catch(() => {});
  }
}

async function operate(request) {
  const args = request.args || {};
  switch (request.operation) {
    case 'access': {
      const item = await target(args.path);
      await fsp.access(item.absolute, args.write ? fs.constants.R_OK | fs.constants.W_OK : fs.constants.R_OK);
      return { accessible: true };
    }
    case 'read_file': {
      const item = await target(args.path);
      const stat = await fsp.lstat(item.absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) fail('SANDBOX_NOT_REGULAR_FILE');
      if (stat.size > MAX_FILE_BYTES) fail('SANDBOX_FILE_TOO_LARGE');
      const buffer = await fsp.readFile(item.absolute);
      return { base64: buffer.toString('base64'), bytes: buffer.length, sha256: digest(buffer) };
    }
    case 'mkdir': {
      // Pi's write tool always asks its filesystem adapter to create the
      // parent directory first. A file at the workspace root therefore
      // legitimately produces "." here; keep every other operation strict.
      const item = await target(args.path, { allowDot: true, mayNotExist: true });
      await fsp.mkdir(item.absolute, { recursive: true });
      await assertRealInside(item.absolute);
      return { created: true };
    }
    case 'write_file': {
      const item = await target(args.path, { mayNotExist: true });
      if (typeof args.content !== 'string' || Buffer.byteLength(args.content, 'utf8') > MAX_FILE_BYTES) fail('SANDBOX_CONTENT_TOO_LARGE');
      await atomicWrite(item.absolute, args.content);
      return { bytes: Buffer.byteLength(args.content, 'utf8'), sha256: digest(args.content) };
    }
    case 'exists': {
      try { await target(args.path, { allowDot: true }); return { exists: true }; }
      catch (error) { if (error && error.code === 'ENOENT') return { exists: false }; throw error; }
    }
    case 'stat': {
      const item = await target(args.path, { allowDot: true });
      const stat = await fsp.lstat(item.absolute);
      if (stat.isSymbolicLink()) fail('SANDBOX_SYMLINK_REJECTED');
      return { directory: stat.isDirectory(), file: stat.isFile(), bytes: stat.size };
    }
    case 'readdir': {
      const item = await target(args.path, { allowDot: true });
      const entries = await fsp.readdir(item.absolute);
      return { entries: entries.filter((name) => !BLOCKED_SEGMENTS.has(name)).slice(0, 2000) };
    }
    case 'glob': {
      const item = await target(args.path, { allowDot: true });
      const limit = Math.max(1, Math.min(Number(args.limit) || 1000, 2000));
      const matcher = globRegex(args.pattern);
      const entries = await walk(item.absolute, limit * 4);
      const matches = entries.filter((entry) => matcher.test(entry.rel) || (!String(args.pattern).includes('/') && matcher.test(path.basename(entry.rel)))).slice(0, limit).map((entry) => entry.rel + (entry.directory ? '/' : ''));
      return { matches };
    }
    case 'grep': {
      const item = await target(args.path || '.', { allowDot: true });
      const limit = Math.max(1, Math.min(Number(args.limit) || 100, 1000));
      const context = Math.max(0, Math.min(Number(args.context) || 0, 20));
      const pattern = String(args.pattern);
      let expression = null;
      if (!args.literal) {
        try {
          expression = new RegExp(pattern, args.ignoreCase ? 'iu' : 'u');
        } catch (error) {
          if (error instanceof SyntaxError) fail('SANDBOX_INVALID_GREP_PATTERN');
          throw error;
        }
      }
      const needle = args.ignoreCase ? pattern.toLocaleLowerCase() : pattern;
      const matcher = args.glob ? globRegex(String(args.glob)) : null;
      const stat = await fsp.stat(item.absolute);
      const entries = stat.isDirectory() ? await walk(item.absolute, 5000) : [{ rel: path.basename(item.absolute), absolute: item.absolute, directory: false }];
      const candidates = entries.filter((entry) => !entry.directory && (!matcher || matcher.test(entry.rel) || matcher.test(path.basename(entry.rel))));
      const rows = [];
      let matches = 0;
      for (let offset = 0; offset < candidates.length; offset += GREP_READ_BATCH_SIZE) {
        // Overlap bind-mount reads, but consume them in traversal order for deterministic limits.
        const batch = candidates.slice(offset, offset + GREP_READ_BATCH_SIZE);
        const contents = await Promise.allSettled(batch.map(async ({ absolute }) => {
          const stat = await fsp.stat(absolute);
          return stat.size > MAX_FILE_BYTES ? null : fsp.readFile(absolute, 'utf8');
        }));
        for (const [entryIndex, read] of contents.entries()) {
          if (read.status === 'rejected') throw read.reason;
          const content = read.value;
          if (content === null || content.includes('\0')) continue;
          const lines = content.replaceAll('\r\n', '\n').split('\n');
          for (let index = 0; index < lines.length; index++) {
            const subject = args.ignoreCase ? lines[index].toLocaleLowerCase() : lines[index];
            expression && (expression.lastIndex = 0);
            if (expression ? expression.test(lines[index]) : subject.includes(needle)) {
              const start = Math.max(0, index - context);
              const end = Math.min(lines.length - 1, index + context);
              for (let row = start; row <= end; row++) rows.push({ path: batch[entryIndex].rel, line: row + 1, text: lines[row].slice(0, 2000), match: row === index });
              if (++matches >= limit) return { rows, matchLimitReached: limit };
            }
          }
        }
      }
      return { rows };
    }
    default: fail('SANDBOX_UNSUPPORTED_OPERATION');
  }
}

(async () => {
  let request;
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!request || request.protocolVersion !== PROTOCOL) fail('SANDBOX_PROTOCOL_MISMATCH');
    if (typeof request.deadlineMs !== 'number' || Date.now() > request.deadlineMs) fail('SANDBOX_DEADLINE_EXCEEDED');
    const result = await operate(request);
    process.stdout.write(JSON.stringify({ protocolVersion: PROTOCOL, runId: request.runId, requestId: request.requestId, toolName: request.toolName, status: 'ok', result: { ...result, execution: { pid: process.pid, cwd: ROOT } } }));
  } catch (error) {
    const errorCode = error && error.code && String(error.code).startsWith('SANDBOX_') ? error.code : 'SANDBOX_WORKER_ERROR';
    process.stdout.write(JSON.stringify({ protocolVersion: PROTOCOL, runId: request && request.runId, requestId: request && request.requestId, toolName: request && request.toolName, status: 'error', errorCode, errorMessage: 'sandbox worker rejected the operation' }));
    if (errorCode !== 'SANDBOX_INVALID_GREP_PATTERN') process.exitCode = 1;
  }
})();
`;
