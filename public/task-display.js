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
    if (['planning', 'running', 'developing', 'testing', 'committing'].includes(status)) {
      return 'developing';
    }
    if (['pending_deploy', 'deploying'].includes(status)) return 'deploy';
    if (['awaiting_input', 'pending_approval'].includes(status)) return 'waiting';
    if (['failed', 'needs_human'].includes(status)) return 'problem';
    if (status === 'done') return 'done';
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
    if (['done', 'failed', 'needs_human', 'pending_deploy'].includes(status)) {
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

  function isTerminalTaskStatus(status) {
    return ['done', 'failed', 'needs_human'].includes(status);
  }

  function isIterableTaskStatus(status) {
    return ['done', 'pending_deploy'].includes(status);
  }

  function isCompletedRoundStatus(status) {
    return ['done', 'pending_deploy', 'failed', 'needs_human'].includes(status);
  }

  function roundLabel(round) {
    return round === 1 ? '初始任务' : `迭代 ${round}`;
  }

  function parseTaskDisplayRounds(events, task) {
    const iterationStarts = [];
    const iterationSummaries = new Map();
    const list = events || [];

    for (let index = 0; index < list.length; index += 1) {
      const event = list[index];
      if (event.type === 'iteration_round') {
        iterationSummaries.set(event.payload?.round, event.payload?.summary || '');
      }
      if (event.type === 'iteration_start') {
        iterationStarts.push({
          index,
          round: event.payload?.round || iterationStarts.length + 2,
        });
      }
    }

    const rounds = [];
    let segmentStart = 0;
    let roundNum = 1;

    for (const start of iterationStarts) {
      rounds.push({
        round: roundNum,
        label: roundLabel(roundNum),
        chunks: parseTaskLogEvents(list.slice(segmentStart, start.index)),
        summary: iterationSummaries.get(roundNum) || '',
        complete: true,
      });
      segmentStart = start.index + 1;
      roundNum = start.round;
    }

    const currentChunks = parseTaskLogEvents(list.slice(segmentStart));
    const complete = isCompletedRoundStatus(task?.status);
    rounds.push({
      round: roundNum,
      label: roundLabel(roundNum),
      chunks: currentChunks,
      summary: complete ? String(task?.result_summary || '').trim() : '',
      complete,
    });
    return rounds;
  }

  function resolveRoundSummary(round, task) {
    const text = String(round?.summary || '').trim();
    if (text) return text;
    if (round?.complete) return summaryPlaceholder(task?.status);
    return summaryPlaceholder('running');
  }

  function renderTaskRoundHtml(round, task, options = {}) {
    const summary = resolveRoundSummary(round, task);
    const hasSummary = Boolean(String(round?.summary || '').trim());
    const summaryClass = hasSummary ? 'markdown' : 'markdown placeholder';
    const summaryContent = hasSummary
      ? formatMarkdown(summary)
      : escapeHtml(summary);
    const showSummary = round.complete || options.showIncompleteSummary;
    const parts = [
      `<section class="iteration-round" data-round="${round.round}">`,
      `<div class="iteration-round-label">${escapeHtml(round.label)}</div>`,
      '<section class="output-section">',
      '<h3>实时输出</h3>',
      `<div class="log-stream">${renderLogChunksHtml(round.chunks, options.logOptions)}</div>`,
      '</section>',
    ];
    if (showSummary) {
      parts.push(
        '<section class="output-section">',
        '<h3>结果摘要</h3>',
        `<div class="summary-box ${summaryClass}">${summaryContent}</div>`,
        '</section>',
      );
    }
    parts.push('</section>');
    return parts.join('');
  }

  function renderTaskRoundsHtml(rounds, task, options = {}) {
    if (!rounds?.length) {
      return renderTaskRoundHtml({
        round: 1,
        label: roundLabel(1),
        chunks: [],
        summary: '',
        complete: isCompletedRoundStatus(task?.status),
      }, task, options);
    }
    return rounds.map((round) => renderTaskRoundHtml(round, task, options)).join('');
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
    isTerminalTaskStatus,
    isIterableTaskStatus,
    isCompletedRoundStatus,
    roundLabel,
    parseTaskDisplayRounds,
    resolveRoundSummary,
    renderTaskRoundHtml,
    renderTaskRoundsHtml,
  };
}));
