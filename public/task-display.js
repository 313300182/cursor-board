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
    const next = Array.isArray(chunks) ? chunks : [];
    next.push({
      stream: normalizeLogStream(payload?.stream),
      text: payload?.chunk || '',
    });
    return next;
  }

  function appendPermissionChunk(chunks, payload) {
    const next = Array.isArray(chunks) ? chunks : [];
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
    result = result.replace(/(?<![*\w])\*([^*\n]+)\*(?![*\w])/g, '<em>$1</em>');
    result = result.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label, href) => {
      if (!/^(https?:|mailto:|\/|#)/i.test(href)) return `[${label}](${href})`;
      return `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    });
    return result;
  }

  function parseTableRow(line) {
    let trimmed = String(line ?? '').trim();
    if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
    if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
    return trimmed.split('|').map((cell) => cell.trim());
  }

  function isTableRow(line) {
    const trimmed = String(line ?? '').trim();
    if (!trimmed.includes('|')) return false;
    return parseTableRow(trimmed).length >= 2;
  }

  function isTableSeparator(line) {
    const cells = parseTableRow(line);
    return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
  }

  function parseTableAlignments(separatorLine) {
    return parseTableRow(separatorLine).map((cell) => {
      const trimmed = cell.trim();
      const left = trimmed.startsWith(':');
      const right = trimmed.endsWith(':');
      if (left && right) return 'center';
      if (right) return 'right';
      return 'left';
    });
  }

  function renderTableRow(cells, tag, alignments) {
    return `<tr>${cells.map((cell, index) => {
      const align = alignments?.[index];
      const style = align && align !== 'left' ? ` style="text-align:${align}"` : '';
      return `<${tag}${style}>${formatInlineMarkdown(cell)}</${tag}>`;
    }).join('')}</tr>`;
  }

  function renderTable(headerCells, bodyRows, alignments) {
    const thead = `<thead>${renderTableRow(headerCells, 'th', alignments)}</thead>`;
    const tbody = bodyRows.length
      ? `<tbody>${bodyRows.map((row) => renderTableRow(row, 'td', alignments)).join('')}</tbody>`
      : '';
    return `<div class="md-table-wrap"><table class="md-table">${thead}${tbody}</table></div>`;
  }

  function isHorizontalRule(line) {
    return /^(-{3,}|\*{3,}|_{3,})\s*$/.test(String(line ?? '').trim());
  }

  function isFenceOpen(line) {
    return /^(`{3,}|~{3,})(\s*\S*)?\s*$/.test(String(line ?? '').trim());
  }

  function parseFenceClose(line, openFence) {
    const marker = openFence.match(/^[`~]+/)[0];
    return new RegExp(`^${marker}\\s*$`).test(String(line ?? '').trim());
  }

  function formatMarkdown(value) {
    const lines = String(value ?? '').split(/\r?\n/);
    const parts = [];
    let listType = null;
    let index = 0;

    const closeList = () => {
      if (listType === 'ul') parts.push('</ul>');
      if (listType === 'ol') parts.push('</ol>');
      listType = null;
    };

    while (index < lines.length) {
      const rawLine = lines[index];
      const line = rawLine.replace(/\s+$/, '');

      if (isFenceOpen(line)) {
        closeList();
        const openFence = line.trim();
        index += 1;
        const codeLines = [];
        while (index < lines.length && !parseFenceClose(lines[index], openFence)) {
          codeLines.push(lines[index]);
          index += 1;
        }
        if (index < lines.length) index += 1;
        parts.push(`<pre class="md-pre"><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
        continue;
      }

      if (isTableRow(line) && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
        closeList();
        const headerCells = parseTableRow(line);
        const alignments = parseTableAlignments(lines[index + 1]);
        index += 2;
        const bodyRows = [];
        while (index < lines.length) {
          const bodyLine = lines[index].replace(/\s+$/, '');
          if (!isTableRow(bodyLine) || isTableSeparator(bodyLine)) break;
          bodyRows.push(parseTableRow(bodyLine));
          index += 1;
        }
        parts.push(renderTable(headerCells, bodyRows, alignments));
        continue;
      }

      if (/^>\s?/.test(line)) {
        closeList();
        const quoteLines = [];
        while (index < lines.length && /^>\s?/.test(lines[index].replace(/\s+$/, ''))) {
          quoteLines.push(lines[index].replace(/\s+$/, '').replace(/^>\s?/, ''));
          index += 1;
        }
        const quoteBody = quoteLines
          .map((quoteLine) => (quoteLine.trim() ? `<p>${formatInlineMarkdown(quoteLine)}</p>` : ''))
          .join('');
        parts.push(`<blockquote class="md-quote">${quoteBody}</blockquote>`);
        continue;
      }

      if (isHorizontalRule(line)) {
        closeList();
        parts.push('<hr class="md-hr">');
        index += 1;
        continue;
      }

      if (/^###\s+/.test(line)) {
        closeList();
        parts.push(`<h3>${formatInlineMarkdown(line.replace(/^###\s+/, ''))}</h3>`);
        index += 1;
        continue;
      }
      if (/^##\s+/.test(line)) {
        closeList();
        parts.push(`<h2>${formatInlineMarkdown(line.replace(/^##\s+/, ''))}</h2>`);
        index += 1;
        continue;
      }
      if (/^#\s+/.test(line)) {
        closeList();
        parts.push(`<h1>${formatInlineMarkdown(line.replace(/^#\s+/, ''))}</h1>`);
        index += 1;
        continue;
      }
      if (/^\d+\.\s+/.test(line)) {
        if (listType !== 'ol') {
          closeList();
          parts.push('<ol>');
          listType = 'ol';
        }
        parts.push(`<li>${formatInlineMarkdown(line.replace(/^\d+\.\s+/, ''))}</li>`);
        index += 1;
        continue;
      }
      if (/^[-*+]\s+/.test(line)) {
        if (listType !== 'ul') {
          closeList();
          parts.push('<ul>');
          listType = 'ul';
        }
        parts.push(`<li>${formatInlineMarkdown(line.replace(/^[-*+]\s+/, ''))}</li>`);
        index += 1;
        continue;
      }
      closeList();
      if (line.trim()) {
        parts.push(`<p>${formatInlineMarkdown(line)}</p>`);
      }
      index += 1;
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

  const LOG_LAZY_CHAR_THRESHOLD = 12000;
  const LOG_LAZY_TAIL_CHARS = 8000;
  const LOG_LAZY_EXPAND_CHARS = 8000;

  function estimateLogTextLength(chunks) {
    return mergeLogChunksForDisplay(chunks)
      .reduce((sum, chunk) => sum + (chunk.text?.length || 0), 0);
  }

  function sliceMergedLogTail(merged, tailChars) {
    if (!merged.length) {
      return { visible: [], hiddenChars: 0, hasHidden: false };
    }
    let budget = Math.max(0, tailChars);
    const visible = [];
    let hiddenChars = 0;
    for (let index = merged.length - 1; index >= 0; index -= 1) {
      const chunk = merged[index];
      const text = chunk.text || '';
      if (budget <= 0) {
        hiddenChars += text.length;
        continue;
      }
      if (text.length <= budget) {
        visible.unshift({ stream: chunk.stream, text });
        budget -= text.length;
      } else {
        const start = text.length - budget;
        hiddenChars += start;
        visible.unshift({ stream: chunk.stream, text: text.slice(start) });
        budget = 0;
      }
    }
    return { visible, hiddenChars, hasHidden: hiddenChars > 0 };
  }

  function planLogLazyDisplay(chunks, options = {}) {
    const merged = mergeLogChunksForDisplay(chunks);
    const totalChars = merged.reduce((sum, chunk) => sum + (chunk.text?.length || 0), 0);
    const threshold = options.threshold ?? LOG_LAZY_CHAR_THRESHOLD;
    if (totalChars <= threshold) {
      return {
        mode: 'full',
        visible: merged,
        totalChars,
        hiddenChars: 0,
        hasHidden: false,
        visibleChars: totalChars,
      };
    }
    const tailChars = options.tailChars ?? LOG_LAZY_TAIL_CHARS;
    const requestedVisible = Math.max(options.visibleChars ?? tailChars, tailChars);
    const visibleChars = Math.min(totalChars, requestedVisible);
    if (visibleChars >= totalChars) {
      return {
        mode: 'full',
        visible: merged,
        totalChars,
        hiddenChars: 0,
        hasHidden: false,
        visibleChars: totalChars,
      };
    }
    const sliced = sliceMergedLogTail(merged, visibleChars);
    return {
      mode: 'lazy',
      visible: sliced.visible,
      totalChars,
      hiddenChars: sliced.hiddenChars,
      hasHidden: sliced.hasHidden,
      visibleChars,
    };
  }

  function formatLazyHiddenHint(hiddenChars) {
    if (hiddenChars >= 10000) return `约 ${Math.round(hiddenChars / 1000)}k 字`;
    if (hiddenChars >= 1000) return `约 ${(hiddenChars / 1000).toFixed(1)}k 字`;
    return `${hiddenChars} 字`;
  }

  function renderLogChunksHtml(chunks, options = {}) {
    const placeholder = options.placeholder || '等待输出…';
    const merged = options.merged || mergeLogChunksForDisplay(chunks);
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

  function renderLogStreamHtml(chunks, options = {}) {
    const plan = planLogLazyDisplay(chunks, options.lazy);
    const inner = renderLogChunksHtml(chunks, {
      placeholder: options.placeholder,
      merged: plan.visible,
    });
    if (plan.mode !== 'lazy' || !plan.hasHidden) return inner;
    return [
      `<button type="button" class="log-lazy-trigger" data-hidden-chars="${plan.hiddenChars}">`,
      `↑ 还有 ${formatLazyHiddenHint(plan.hiddenChars)} 更早输出，点击或向上滚动加载`,
      '</button>',
      inner,
    ].join('');
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
    const lazyOptions = options.lazyByRound?.[round.round] || options.lazy || {};
    const logOptions = {
      ...(options.logOptions || {}),
      lazy: lazyOptions,
    };
    const parts = [
      `<section class="iteration-round" data-round="${round.round}">`,
      `<div class="iteration-round-label">${escapeHtml(round.label)}</div>`,
      '<section class="output-section">',
      '<h3>实时输出</h3>',
      `<div class="log-stream" data-round="${round.round}">${renderLogStreamHtml(round.chunks, logOptions)}</div>`,
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
    LOG_LAZY_CHAR_THRESHOLD,
    LOG_LAZY_TAIL_CHARS,
    LOG_LAZY_EXPAND_CHARS,
    estimateLogTextLength,
    sliceMergedLogTail,
    planLogLazyDisplay,
    formatLazyHiddenHint,
    renderLogChunksHtml,
    renderLogStreamHtml,
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
