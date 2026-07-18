const fs = require('node:fs/promises');
const path = require('node:path');
const { parseFrontmatter } = require('./project-rules');

async function walkSkillFiles(directory) {
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
      files.push(...await walkSkillFiles(fullPath));
    } else if (entry.isFile() && entry.name.toLowerCase() === 'skill.md') {
      files.push(fullPath);
    }
  }
  return files;
}

async function scanProjectSkills(workdir) {
  if (!workdir) return [];
  const skillsRoot = path.join(workdir, '.cursor', 'skills');
  const files = await walkSkillFiles(skillsRoot);
  const skills = [];
  for (const filePath of files.sort()) {
    const source = await fs.readFile(filePath, 'utf8');
    const parsed = parseFrontmatter(source);
    const folderName = path.basename(path.dirname(filePath));
    skills.push({
      name: folderName,
      relativePath: path.relative(workdir, filePath),
      metadata: parsed.metadata,
      content: parsed.content,
    });
  }
  return skills;
}

async function scanProjectSkillsForWorkdirs(workdirs) {
  const all = [];
  for (const entry of workdirs || []) {
    const skills = await scanProjectSkills(entry.path);
    const prefix = entry.label || path.basename(entry.path);
    for (const skill of skills) {
      all.push({
        ...skill,
        workdir: entry.path,
        workdirLabel: entry.label || entry.path,
        relativePath: prefix
          ? path.join(prefix, skill.relativePath)
          : skill.relativePath,
      });
    }
  }
  return all;
}

module.exports = {
  scanProjectSkills,
  scanProjectSkillsForWorkdirs,
};
