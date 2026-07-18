/**
 * Kanban column display ordering (does not affect scheduler FIFO).
 * @author Amadeus
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof root !== 'undefined') {
    root.TaskDisplay = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function statusGroup(status) {
    if (status === 'developing') return 'developing';
    if (status === 'testing') return 'testing';
    if (status === 'committing') return 'committing';
    if (['pending_deploy', 'deploying'].includes(status)) return 'deploy';
    if (status === 'planning') return 'planning';
    if (['awaiting_input', 'pending_approval'].includes(status)) return 'waiting';
    if (['failed', 'needs_human'].includes(status)) return 'problem';
    if (status === 'running') return 'running';
    return status;
  }

  function compareTimeDesc(left, right) {
    const a = left || '';
    const b = right || '';
    if (a === b) return 0;
    return a > b ? -1 : 1;
  }

  function sortTasksForGroup(tasks, group) {
    const sorted = [...tasks];
    if (group === 'pending') {
      return sorted.sort((left, right) => compareTimeDesc(left.created_at, right.created_at));
    }
    if (group === 'done') {
      return sorted.sort((left, right) => compareTimeDesc(
        left.finished_at || left.created_at,
        right.finished_at || right.created_at,
      ));
    }
    if (group === 'problem') {
      return sorted.sort((left, right) => compareTimeDesc(
        left.finished_at || left.started_at || left.created_at,
        right.finished_at || right.started_at || right.created_at,
      ));
    }
    return sorted.sort((left, right) => compareTimeDesc(
      left.started_at || left.created_at,
      right.started_at || right.created_at,
    ));
  }

  function normalizeLogStream(stream) {
    if (stream === 'thinking' || stream === 'system') return stream;
    return 'message';
  }

  function parseTaskLogEvents(events) {
    const chunks = [];
    for (const event of events || []) {
      if (event.type === 'log_chunk') {
        chunks.push({
          stream: normalizeLogStream(event.payload?.stream),
          text: event.payload?.chunk || '',
        });
        continue;
      }
      if (event.type === 'permission') {
        chunks.push({
          stream: 'system',
          text: `[审批] ${event.payload?.tool || 'unknown'} → ${event.payload?.action || 'unknown'}\n`,
        });
      }
    }
    return chunks;
  }

  function appendLogChunk(chunks, payload) {
    const next = Array.isArray(chunks) ? [...chunks] : [];
    next.push({
      stream: normalizeLogStream(payload?.stream),
      text: payload?.chunk || '',
    });
    return next;
  }

  function appendPermissionChunk(chunks, payload) {
    const next = Array.isArray(chunks) ? [...chunks] : [];
    next.push({
      stream: 'system',
      text: `[审批] ${payload?.tool || 'unknown'} → ${payload?.action || 'unknown'}\n`,
    });
    return next;
  }

  function summaryPlaceholder(status) {
    if (['done', 'failed', 'needs_human'].includes(status)) {
      return '暂无结果摘要';
    }
    return '任务执行中，完成后将在此显示摘要…';
  }

  function resolveTaskSummary(task) {
    const text = String(task?.result_summary || '').trim();
    if (text) return text;
    return summaryPlaceholder(task?.status);
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  }

  function formatInlineMarkdown(text) {
    let result = escapeHtml(text);
    result = result.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    result = result.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    return result;
  }

  function formatMarkdown(value) {
    const lines = String(value ?? '').split(/\r?\n/);
    const parts = [];
    let listOpen = false;

    const closeList = () => {
      if (listOpen) {
        parts.push('</ul>');
        listOpen = false;
      }
    };

    for (const rawLine of lines) {
      const line = rawLine.replace(/\s+$/, '');
      if (/^###\s+/.test(line)) {
        closeList();
        parts.push(`<h3>${formatInlineMarkdown(line.replace(/^###\s+/, ''))}</h3>`);
        continue;
      }
      if (/^##\s+/.test(line)) {
        closeList();
        parts.push(`<h2>${formatInlineMarkdown(line.replace(/^##\s+/, ''))}</h2>`);
        continue;
      }
      if (/^#\s+/.test(line)) {
        closeList();
        parts.push(`<h1>${formatInlineMarkdown(line.replace(/^#\s+/, ''))}</h1>`);
        continue;
      }
      if (/^[-*]\s+/.test(line)) {
        if (!listOpen) {
          parts.push('<ul>');
          listOpen = true;
        }
        parts.push(`<li>${formatInlineMarkdown(line.replace(/^[-*]\s+/, ''))}</li>`);
        continue;
      }
      closeList();
      if (line.trim()) {
        parts.push(`<p>${formatInlineMarkdown(line)}</p>`);
      }
    }
    closeList();
    return parts.join('');
  }

  function mergeLogChunksForDisplay(chunks) {
    const merged = [];
    for (const chunk of chunks || []) {
      const stream = normalizeLogStream(chunk?.stream);
      const text = chunk?.text || '';
      const last = merged[merged.length - 1];
      if (last && last.stream === stream) {
        last.text += text;
        continue;
      }
      merged.push({ stream, text });
    }
    return merged;
  }

  function renderLogChunksHtml(chunks, options = {}) {
    const placeholder = options.placeholder || '等待输出…';
    const merged = mergeLogChunksForDisplay(chunks);
    if (!merged.length) {
      return `<div class="log-chunk log-chunk-system">${escapeHtml(placeholder)}</div>`;
    }
    return merged.map((chunk) => {
      const cls = chunk.stream === 'thinking'
        ? 'log-chunk-thinking'
        : chunk.stream === 'system'
          ? 'log-chunk-system'
          : 'log-chunk-message';
      const content = chunk.stream === 'message'
        ? formatMarkdown(chunk.text)
        : escapeHtml(chunk.text);
      return `<div class="log-chunk ${cls}">${content}</div>`;
    }).join('');
  }

  const DONE_VISIBLE_DEFAULT = 7;

  function limitDoneTasksForDisplay(tasks, expanded) {
    const total = tasks.length;
    if (expanded || total <= DONE_VISIBLE_DEFAULT) {
      return { visible: tasks, hiddenCount: 0, total };
    }
    return {
      visible: tasks.slice(0, DONE_VISIBLE_DEFAULT),
      hiddenCount: total - DONE_VISIBLE_DEFAULT,
      total,
    };
  }

  function isActiveTaskStatus(status) {
    return ['planning', 'running', 'developing', 'testing', 'committing', 'deploying'].includes(status);
  }

  return {
    statusGroup,
    sortTasksForGroup,
    normalizeLogStream,
    parseTaskLogEvents,
    appendLogChunk,
    appendPermissionChunk,
    summaryPlaceholder,
    resolveTaskSummary,
    escapeHtml,
    formatInlineMarkdown,
    formatMarkdown,
    mergeLogChunksForDisplay,
    renderLogChunksHtml,
    DONE_VISIBLE_DEFAULT,
    limitDoneTasksForDisplay,
    isActiveTaskStatus,
  };
}));
