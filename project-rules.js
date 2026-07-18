const fs = require('node:fs/promises');
const path = require('node:path');

function parseFrontmatter(source) {
  if (!source.startsWith('---')) {
    return { metadata: {}, content: source.trim() };
  }
  const end = source.indexOf('\n---', 3);
  if (end === -1) {
    return { metadata: {}, content: source.trim() };
  }
  const metadata = {};
  const header = source.slice(3, end).trim();
  for (const line of header.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (value === 'true') value = true;
    if (value === 'false') value = false;
    metadata[key] = value;
  }
  return {
    metadata,
    content: source.slice(end + 4).trim(),
  };
}

async function walkMdcFiles(directory) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkMdcFiles(fullPath));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.mdc')) {
      files.push(fullPath);
    }
  }
  return files;
}

async function scanProjectRules(workdir) {
  if (!workdir) return [];
  const rulesRoot = path.join(workdir, '.cursor', 'rules');
  const files = await walkMdcFiles(rulesRoot);
  const rules = [];
  for (const filePath of files.sort()) {
    const source = await fs.readFile(filePath, 'utf8');
    const parsed = parseFrontmatter(source);
    rules.push({
      name: path.basename(filePath),
      relativePath: path.relative(workdir, filePath),
      metadata: parsed.metadata,
      content: parsed.content,
    });
  }
  return rules;
}

async function scanProjectRulesForWorkdirs(workdirs) {
  const all = [];
  for (const entry of workdirs || []) {
    const rules = await scanProjectRules(entry.path);
    const prefix = entry.label || path.basename(entry.path);
    for (const rule of rules) {
      all.push({
        ...rule,
        workdir: entry.path,
        workdirLabel: entry.label || entry.path,
        relativePath: prefix
          ? path.join(prefix, rule.relativePath)
          : rule.relativePath,
      });
    }
  }
  return all;
}

module.exports = {
  parseFrontmatter,
  scanProjectRules,
  scanProjectRulesForWorkdirs,
};
