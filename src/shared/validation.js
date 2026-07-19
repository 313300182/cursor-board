const fs = require('fs');

const MAX_ATTACHMENT_DATA_LENGTH = 3 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_DATA_LENGTH = 8 * 1024 * 1024;

function isWorkdirAllowed(workdir, allowedList) {
  const normalized = workdir.replace(/\//g, '\\');
  return (allowedList || []).some((prefix) => {
    const p = prefix.replace(/\//g, '\\');
    return normalized.toLowerCase().startsWith(p.toLowerCase());
  });
}

function validateWorkdirs({ workdirs, allowed, isAllowed, allowedFirst = false }) {
  for (const entry of workdirs) {
    const workdir = typeof entry === 'string' ? entry : entry.path;
    const validateAllowed = () => {
      if (!(isAllowed ? isAllowed(workdir) : isWorkdirAllowed(workdir, allowed))) {
        throw new Error(`工作目录不在白名单内: ${workdir}`);
      }
    };
    const validateExists = () => {
      if (!fs.existsSync(workdir) || !fs.statSync(workdir).isDirectory()) {
        throw new Error(`工作目录不存在或不是文件夹: ${workdir}`);
      }
    };
    if (allowedFirst) {
      validateAllowed();
      validateExists();
    } else {
      validateExists();
      validateAllowed();
    }
  }
}

function normalizeAttachments(attachments, options = {}) {
  if (!Array.isArray(attachments)) return [];
  const {
    trimValues = true,
    includeField = false,
    maxItems = Infinity,
    rejectOversize = true,
    enforceTotal = true,
  } = options;
  const result = [];
  let totalLength = 0;

  for (const item of attachments) {
    const mimeType = trimValues
      ? String(item?.mimeType || '').trim()
      : String(item?.mimeType || '');
    const data = trimValues
      ? String(item?.data || '').trim()
      : String(item?.data || '');
    if (!mimeType.startsWith('image/') || !data) continue;

    if (data.length > MAX_ATTACHMENT_DATA_LENGTH) {
      if (rejectOversize) throw new Error('单个图片附件过大');
      continue;
    }
    if (enforceTotal && totalLength + data.length > MAX_TOTAL_ATTACHMENT_DATA_LENGTH) {
      throw new Error('图片附件总大小过大');
    }
    totalLength += data.length;
    const normalized = { mimeType, data };
    if (includeField) {
      normalized.field = item?.field ? String(item.field) : null;
    }
    result.push(normalized);
    if (result.length >= maxItems) break;
  }
  return result;
}

module.exports = {
  MAX_ATTACHMENT_DATA_LENGTH,
  isWorkdirAllowed,
  validateWorkdirs,
  normalizeAttachments,
};
